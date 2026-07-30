// spacemoused — bridges the 3Dconnexion driver to the gcoordinator extension.
//
// The 3DxWare DriverKit extension seizes the physical SpaceMouse at the IOKit
// level, so the raw HID interface cannot be opened at all while the driver runs
// (neither exclusively nor non-exclusively). The driver instead delivers 6-DoF
// data over Mach IPC to clients registered through 3DconnexionClient.framework.
// This helper is that client: it prints one JSON object per line on stdout and
// reads "activate"/"deactivate" commands on stdin.
//
// The framework is loaded with dlopen rather than linked, so the binary still
// launches on machines where the driver is not installed — it exits with
// EXIT_NO_DRIVER and the extension reports that 3DxWare is required.
//
// Build: npm run build:native

#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

#define EXIT_NO_DRIVER 2
#define EXIT_NO_SYMBOLS 3
#define EXIT_REGISTER_FAILED 4

#define FRAMEWORK_PATH \
    "/Library/Frameworks/3DconnexionClient.framework/3DconnexionClient"

// ---- ABI copied verbatim from ConnexionClient.h ----

#define kConnexionClientManual        0x2B2B2B2B  // '++++'
#define kConnexionClientModeTakeOver  1
#define kConnexionMaskAll             0x3FFF
#define kConnexionMaskAllButtons      0xFFFFFFFF
#define kConnexionMsgDeviceState      0x33645352  // '3dSR'
#define kConnexionCtlActivateClient   0x33646163  // '3dac'
#define kConnexionCtlDeactivateClient 0x33646463  // '3ddc'

// The real header declares this inside #pragma pack(push,2). Without it the
// natural 8-byte alignment of `time` shifts everything from `report` onward by
// 4 bytes, and axis[4]/axis[5] end up reading `address` and `buttons`.
#pragma pack(push, 2)
typedef struct {
    uint16_t version;
    uint16_t client;
    uint16_t command;
    int16_t  param;
    int32_t  value;
    uint64_t time;
    uint8_t  report[8];
    union {
        uint16_t buttons8;
        uint16_t appEventPressed;
    };
    int16_t  axis[6];   // x, y, z, rx, ry, rz
    uint16_t address;
    uint32_t buttons;
} ConnexionDeviceState;
#pragma pack(pop)

_Static_assert(sizeof(ConnexionDeviceState) == 48, "ConnexionDeviceState ABI mismatch");
_Static_assert(__builtin_offsetof(ConnexionDeviceState, axis) == 30, "axis offset");

typedef void (*ConnexionAddedHandlerProc)(unsigned int productID);
typedef void (*ConnexionRemovedHandlerProc)(unsigned int productID);
typedef void (*ConnexionMessageHandlerProc)(unsigned int productID,
                                            unsigned int messageType,
                                            void *messageArgument);

typedef int16_t  (*fn_SetConnexionHandlers)(ConnexionMessageHandlerProc,
                                            ConnexionAddedHandlerProc,
                                            ConnexionRemovedHandlerProc, bool);
typedef int16_t  (*fn_InstallConnexionHandlers)(ConnexionMessageHandlerProc,
                                                ConnexionAddedHandlerProc,
                                                ConnexionRemovedHandlerProc);
typedef void     (*fn_CleanupConnexionHandlers)(void);
typedef uint16_t (*fn_RegisterConnexionClient)(uint32_t, uint8_t *, uint16_t, uint32_t);
typedef void     (*fn_SetConnexionClientMask)(uint16_t, uint32_t);
typedef void     (*fn_SetConnexionClientButtonMask)(uint16_t, uint32_t);
typedef void     (*fn_UnregisterConnexionClient)(uint16_t);
typedef int16_t  (*fn_ConnexionClientControl)(uint16_t, uint32_t, int32_t, int32_t *);

static fn_CleanupConnexionHandlers    p_Cleanup;
static fn_RegisterConnexionClient     p_Register;
static fn_SetConnexionClientMask      p_SetMask;
static fn_SetConnexionClientButtonMask p_SetButtonMask;
static fn_UnregisterConnexionClient   p_Unregister;
static fn_ConnexionClientControl      p_Control;

static uint16_t g_clientID = 0;
static bool     g_active   = false;

// ---- Output ----

// stdout is consumed line-by-line by the extension host, so every write is a
// single flushed line of JSON.
static void emit(const char *fmt, ...) {
    static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
    va_list ap;
    pthread_mutex_lock(&lock);
    va_start(ap, fmt);
    vfprintf(stdout, fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
    pthread_mutex_unlock(&lock);
}

// ---- Driver callbacks ----

static void onMessage(unsigned int productID, unsigned int messageType, void *arg) {
    (void)productID;  // always 0 in state messages
    if (messageType != kConnexionMsgDeviceState || arg == NULL) { return; }
    ConnexionDeviceState *s = (ConnexionDeviceState *)arg;
    if (s->client != g_clientID) { return; }

    emit("{\"t\":\"state\","
         "\"tx\":%d,\"ty\":%d,\"tz\":%d,\"rx\":%d,\"ry\":%d,\"rz\":%d,"
         "\"buttons\":%u}",
         s->axis[0], s->axis[1], s->axis[2], s->axis[3], s->axis[4], s->axis[5],
         s->buttons);
}

static void onAdded(unsigned int productID) {
    emit("{\"t\":\"added\",\"product\":%u}", productID);
}

static void onRemoved(unsigned int productID) {
    emit("{\"t\":\"removed\",\"product\":%u}", productID);
}

// ---- Activation ----

// Registered with the kConnexionClientManual signature, so the driver routes
// data to us only while we explicitly say we are in the foreground. That is what
// keeps the SpaceMouse working normally in Fusion 360 and friends: when VS Code
// loses focus the extension sends "deactivate" and the driver takes over again.
static void applyActive(bool want) {
    if (want == g_active || g_clientID == 0) { return; }
    g_active = want;
    int32_t result = 0;
    p_Control(g_clientID,
              want ? kConnexionCtlActivateClient : kConnexionCtlDeactivateClient,
              0, &result);
}

// stdin is read on its own thread; the framework call is hopped back onto the
// run loop thread that owns the client registration.
static void *stdinThread(void *unused) {
    (void)unused;
    char line[256];
    while (fgets(line, sizeof(line), stdin)) {
        bool want;
        if (strncmp(line, "activate", 8) == 0)        { want = true;  }
        else if (strncmp(line, "deactivate", 10) == 0) { want = false; }
        else { continue; }

        CFRunLoopRef rl = CFRunLoopGetMain();
        CFRunLoopPerformBlock(rl, kCFRunLoopCommonModes, ^{ applyActive(want); });
        CFRunLoopWakeUp(rl);
    }
    // Parent closed the pipe — shut down.
    CFRunLoopStop(CFRunLoopGetMain());
    return NULL;
}

static void onSignal(int sig) {
    (void)sig;
    CFRunLoopStop(CFRunLoopGetMain());
}

// ---- main ----

int main(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);

    void *lib = dlopen(FRAMEWORK_PATH, RTLD_LAZY | RTLD_LOCAL);
    if (!lib) {
        emit("{\"t\":\"error\",\"reason\":\"driver-not-installed\",\"detail\":\"%s\"}",
             dlerror() ? dlerror() : "dlopen failed");
        return EXIT_NO_DRIVER;
    }

    fn_SetConnexionHandlers     setHandlers = dlsym(lib, "SetConnexionHandlers");
    fn_InstallConnexionHandlers installHandlers = dlsym(lib, "InstallConnexionHandlers");
    p_Cleanup       = dlsym(lib, "CleanupConnexionHandlers");
    p_Register      = dlsym(lib, "RegisterConnexionClient");
    p_SetMask       = dlsym(lib, "SetConnexionClientMask");
    p_SetButtonMask = dlsym(lib, "SetConnexionClientButtonMask");
    p_Unregister    = dlsym(lib, "UnregisterConnexionClient");
    p_Control       = dlsym(lib, "ConnexionClientControl");

    if (!p_Register || !p_Unregister || !p_Control || !p_Cleanup ||
        (!setHandlers && !installHandlers)) {
        emit("{\"t\":\"error\",\"reason\":\"missing-symbols\"}");
        return EXIT_NO_SYMBOLS;
    }

    // Handlers must be installed before registering the client.
    int16_t rc = setHandlers ? setHandlers(onMessage, onAdded, onRemoved, false)
                             : installHandlers(onMessage, onAdded, onRemoved);
    if (rc != 0) {
        emit("{\"t\":\"error\",\"reason\":\"handlers\",\"rc\":%d}", rc);
        return EXIT_REGISTER_FAILED;
    }

    g_clientID = p_Register(kConnexionClientManual, (uint8_t *)"\014gcoordinator",
                            kConnexionClientModeTakeOver, kConnexionMaskAll);
    if (g_clientID == 0) {
        emit("{\"t\":\"error\",\"reason\":\"register-failed\"}");
        p_Cleanup();
        return EXIT_REGISTER_FAILED;
    }
    if (p_SetMask)       { p_SetMask(g_clientID, kConnexionMaskAll); }
    if (p_SetButtonMask) { p_SetButtonMask(g_clientID, kConnexionMaskAllButtons); }

    emit("{\"t\":\"ready\",\"clientID\":%u}", g_clientID);

    signal(SIGTERM, onSignal);
    signal(SIGINT, onSignal);
    signal(SIGPIPE, SIG_IGN);

    pthread_t tid;
    pthread_create(&tid, NULL, stdinThread, NULL);
    pthread_detach(tid);

    CFRunLoopRun();

    applyActive(false);
    p_Unregister(g_clientID);
    p_Cleanup();
    return 0;
}

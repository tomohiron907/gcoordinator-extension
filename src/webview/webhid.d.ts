// Minimal WebHID API type declarations
// The WebHID spec is not yet in TypeScript's lib.dom.d.ts

interface HIDDevice {
    readonly productName: string;
    readonly opened: boolean;
    open(): Promise<void>;
    close(): Promise<void>;
    addEventListener(type: 'inputreport', listener: (event: HIDInputReportEvent) => void): void;
    removeEventListener(type: 'inputreport', listener: (event: HIDInputReportEvent) => void): void;
}

interface HIDInputReportEvent extends Event {
    readonly reportId: number;
    readonly data: DataView;
    readonly device: HIDDevice;
}

interface HIDConnectionEvent extends Event {
    readonly device: HIDDevice;
}

interface HIDDeviceFilter {
    vendorId?: number;
    productId?: number;
}

interface HIDDeviceRequestOptions {
    filters: HIDDeviceFilter[];
}

interface HID extends EventTarget {
    requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]>;
    addEventListener(type: 'connect' | 'disconnect', listener: (event: HIDConnectionEvent) => void): void;
}

interface Navigator {
    readonly hid: HID;
}

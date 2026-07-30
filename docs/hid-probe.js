// Windows で SpaceMouse を生 HID から読めるかを、拡張機能抜きで確認するスクリプト。
// 通常の動作確認では不要 — docs/windows-testing.md の「切り分け」で使う。
//
//   mkdir hid-probe && cd hid-probe
//   npm init -y && npm i node-hid@3
//   node hid-probe.js
//
// 3DxWare を動かしたまま実行すること。これが動けば拡張機能側も動く。

const HID = require('node-hid');

const VENDOR_IDS = [0x256f, 0x046d];

const all = HID.devices().filter(d => VENDOR_IDS.includes(d.vendorId));
if (all.length === 0) {
    console.log('SpaceMouse が見つかりません。接続を確認してください。');
    process.exit(1);
}

console.log('--- 見つかったインタフェース ---');
for (const d of all) {
    console.log(
        `vid=0x${d.vendorId.toString(16)} pid=0x${d.productId.toString(16)}`,
        `usagePage=${d.usagePage} usage=${d.usage}`,
        `product=${JSON.stringify(d.product)}`,
        `path=${d.path}`,
    );
}

// 拡張機能と同じ選び方: Generic Desktop / Multi-axis Controller を優先。
const target = all.find(d => d.usagePage === 0x01 && d.usage === 0x08) ?? all[0];
console.log(`\n--- ${target.product} を開きます ---`);

let device;
try {
    device = new HID.HID(target.path);
} catch (err) {
    console.log('オープン失敗:', err.message);
    console.log('→ 3DxWare がデバイスを占有しています。SDK ヘルパー方式が必要です。');
    process.exit(1);
}
console.log('オープン成功。パックを動かしてください (Ctrl-C で終了)\n');

device.on('error', err => console.log('error:', err.message));
device.on('data', data => {
    const id = data[0];
    const words = [];
    for (let i = 1; i + 1 < data.length; i += 2) {
        words.push(String(data.readInt16LE(i)).padStart(6));
    }
    console.log(`report=${id} len=${data.length} int16=[${words.join(' ')}] raw=${data.toString('hex')}`);
});

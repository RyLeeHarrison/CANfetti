import readline from 'readline';
import { GsUsb } from '../index.mjs';

const defaultArbitrationId = 0x123;

async function main() {
    const can = new GsUsb();
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        console.log('Initializing CAN interface...');
        await can.init({
            retries: 5, // Retry 5 times if no device found
            bitrate: GsUsb.Protocol.BITRATE.DEFAULT // 500kbps
        });

        await can.startListening();
        
        // Simple send 8 byte string to send as can frame data
        // Ex String: 0x01 0x02 0x03 0x04 0x05 0x06 0x07 0x08
        rl.on('line', (input) => can.sendHex(input, defaultArbitrationId));

        console.log('CAN initialized at 500kbps');

        can.on('frame', frame => {
            // GsUsbFrame objects .toString() method is useful for debugging and visualization
            console.log(frame.toString());
        });

        can.on('error', error => {
            console.error('CAN error:', error);
        });

        process.on('SIGINT', async () => {
            console.log('\nStopping CAN interface...');
            await can.cleanup();
            process.exit(0);
        });

    } catch (error) {
        console.error('Fatal error:', error);

        if (can) {
            await can.cleanup();
        }

        process.exit(1);
    }
}

main();
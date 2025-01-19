import EventEmitter from 'events';
import usb from 'usb';
import { CAN, GsUsbFrame } from './GsUsbFrame.mjs';

class GsUsb extends EventEmitter {
    static Protocol = {
        BREQ: {
            HOST_FORMAT: 0,
            BITTIMING: 1,
            MODE: 2,
            BERR: 3,
            BT_CONST: 4,
            DEVICE_CONFIG: 5,
            TIMESTAMP: 6,
            IDENTIFY: 7
        },
        MODE: {
            RESET: 0,
            START: 1
        },
        CAN_MODE: {
            NORMAL: 0,
            LISTEN_ONLY: 1,
            LOOPBACK: 2,
            TRIPLE_SAMPLING: 3
        },
        USB: {
            DIR_OUT: 0,
            TYPE_VENDOR: (0x02 << 5),
            RECIP_INTERFACE: 0x01,
            VENDOR_ID: 0x1d50,
            PRODUCT_ID: 0x606f
        },
        BITRATE: {
            CLOCK: 48000000,
            DEFAULT: 500000,
            SAMPLE_POINT: 0.875
        }
    };

    #device = null;
    #interface = null;
    #inEndpoint = null;
    #outEndpoint = null;
    #isConnected = false;
    #packetSize = 512;
    #bitrate = GsUsb.Protocol.BITRATE.DEFAULT;

    get isConnected() { return this.#isConnected; }
    get packetSize() { return this.#packetSize; }
    get bitrate() { return this.#bitrate; }

    #calculateBitTiming(bitrate) {
        const clock = GsUsb.Protocol.BITRATE.CLOCK;
        const samplePoint = GsUsb.Protocol.BITRATE.SAMPLE_POINT;
        
        const nominalBitTime = clock / bitrate;
        const tseg1 = Math.floor(nominalBitTime * samplePoint);
        const tseg2 = nominalBitTime - tseg1 - 1;
        
        const brp = Math.floor((tseg1 + tseg2 + 1) / 16);
        const realTseg1 = Math.floor(tseg1 / brp) - 1;
        const realTseg2 = Math.floor(tseg2 / brp) - 1;
        
        return {
            prop_seg: 1,
            phase_seg1: realTseg1 - 1,
            phase_seg2: realTseg2,
            sjw: 1,
            brp: brp
        };
    }

    async #setBitTiming(bitrate) {
        const timing = this.#calculateBitTiming(bitrate);
        const data = Buffer.alloc(20);
        
        data.writeUInt32LE(timing.prop_seg, 0);
        data.writeUInt32LE(timing.phase_seg1, 4);
        data.writeUInt32LE(timing.phase_seg2, 8);
        data.writeUInt32LE(timing.sjw, 12);
        data.writeUInt32LE(timing.brp, 16);
        
        await this.sendControl(GsUsb.Protocol.BREQ.BITTIMING, 0, data);
        this.#bitrate = bitrate;
    }

    async #findDevice(retries = 3) {
        for (let i = 0; i < retries; i++) {
            const devices = usb.getDeviceList().filter(dev =>
                dev.deviceDescriptor.idVendor === GsUsb.Protocol.USB.VENDOR_ID &&
                dev.deviceDescriptor.idProduct === GsUsb.Protocol.USB.PRODUCT_ID
            );
            
            if (devices.length > 0) {
                const device = devices[0];
                try {
                    device.open();
                    return device;
                } catch (err) {
                    console.warn(`Device open failed (${i + 1}/${retries}):`, err);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error(`Device not found after ${retries} attempts`);
    }

    async send(command) {
        if (!this.#isConnected) throw new Error('Device not initialized');
        
        return new Promise((resolve, reject) => {
            this.#outEndpoint.transfer(command, error => {
                error ? reject(error) : resolve();
            });
        });
    }

    async sendControl(breq, value, data) {
        if (!Buffer.isBuffer(data)) {
            data = Buffer.from(data);
        }
        return new Promise((resolve, reject) => {
            const { DIR_OUT, TYPE_VENDOR, RECIP_INTERFACE } = GsUsb.Protocol.USB;
            try {
                this.#device.controlTransfer(
                    DIR_OUT | TYPE_VENDOR | RECIP_INTERFACE,
                    breq,
                    value,
                    this.#interface.interfaceNumber,
                    data,
                    error => error ? reject(error) : resolve()
                );
            } catch (error) {
                reject(error);
            }
        });
    }

    async setMode(mode, flags) {
        const data = Buffer.alloc(8);
        data.writeUInt32LE(mode, 0);
        data.writeUInt32LE(flags, 4);
        return this.sendControl(GsUsb.Protocol.BREQ.MODE, 0x00, data);
    }

    #startReceiving() {
        const handleTransfer = () => {
            if (!this.#isConnected) return;
            this.#inEndpoint.transfer(this.#packetSize, (error, data) => {
                if (error) {
                    this.emit('error', error);
                    if (this.#isConnected) {
                        setTimeout(handleTransfer, 100);
                    }
                    return;
                }
                if (data?.length >= CAN.FRAME_SIZE) {
                    try {
                        const frame = GsUsbFrame.unpack(Buffer.from(data));
                        this.emit('frame', frame);
                    } catch (err) {
                        this.emit('error', new Error(`Frame parse error: ${err.message}`));
                    }
                }
                if (this.#isConnected) {
                    setImmediate(handleTransfer);
                }
            });
        };
        handleTransfer();
    }

    async init({ retries = 3, mode = 'normal', bitrate = GsUsb.Protocol.BITRATE.DEFAULT } = {}) {
        try {
            this.#device = await this.#findDevice(retries);
            this.#interface = this.#device.interface(0);
            if (process.platform === 'linux' && this.#interface.isKernelDriverActive()) {
                this.#interface.detachKernelDriver();
            }
            this.#interface.claim();
            
            this.#inEndpoint = this.#interface.endpoints.find(e => e.direction === 'in');
            this.#outEndpoint = this.#interface.endpoints.find(e => e.direction === 'out');
            if (!this.#inEndpoint || !this.#outEndpoint) {
                throw new Error('Required endpoints not found');
            }
            this.#packetSize = this.#inEndpoint.descriptor.wMaxPacketSize;
            const { MODE, CAN_MODE } = GsUsb.Protocol;
            
            await this.setMode(MODE.RESET, CAN_MODE.NORMAL);
            
            const hostFormat = Buffer.alloc(4);
            hostFormat.writeUInt32LE(0xEFBE0000, 0);
            await this.sendControl(GsUsb.Protocol.BREQ.HOST_FORMAT, 0x01, hostFormat);
            
            await this.#setBitTiming(bitrate);
            
            await this.setMode(
                MODE.START,
                mode === 'listenOnly' ? CAN_MODE.LISTEN_ONLY : CAN_MODE.NORMAL
            );
            
            this.#isConnected = true;
            this.emit('connected');
        } catch (error) {
            await this.cleanup();
            throw error;
        }
    }

    async sendFrame(arbitrationId, data) {
        if (!this.#isConnected) {
            throw new Error('Device not initialized');
        }
        const frame = new GsUsbFrame(arbitrationId, data);
        frame.echoId = CAN.NONE_ECHO_ID;
        return this.send(frame.pack());
    }

    startListening() {
        if (!this.#isConnected) {
            throw new Error('Device not initialized');
        }
        this.#startReceiving();
    }

    async sendHex(hexString, arbitrationId = 0x1) {
        const buffer = GsUsb.hexToBuffer(hexString);
        return this.sendFrame(arbitrationId, buffer);
    }
    
    static hexToBuffer(hexString) {
        const cleanHex = hexString.replace(/[^0-9A-Fa-f ]/g, '');
        const bytes = cleanHex.split(' ').map(byte => parseInt(byte, 16));
        return Buffer.from(bytes);
    }

    async cleanup() {
        this.#isConnected = false;
        if (this.#interface) {
            return new Promise(resolve => {
                try {
                    this.#interface.release(err => {
                        if (err) console.error('Release error:', err);
                        if (this.#device) this.#device.close();
                        resolve();
                    });
                } catch (error) {
                    console.error('Cleanup error:', error);
                    resolve();
                }
            });
        }
    }
}

export default GsUsb;
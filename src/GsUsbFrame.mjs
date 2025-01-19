const CAN = {
    EFF_FLAG: 0x80000000,
    RTR_FLAG: 0x40000000,
    ERR_FLAG: 0x20000000,
    EFF_MASK: 0x1FFFFFFF,
    NONE_ECHO_ID: 0xFFFFFFFF,
    FRAME_SIZE: 20,
    FRAME_SIZE_HW_TIMESTAMP: 24
};

class GsUsbFrame {
    #buffer;

    static FLAGS = {
        EXTENDED: CAN.EFF_FLAG,
        REMOTE: CAN.RTR_FLAG,
        ERROR: CAN.ERR_FLAG,
        ID_MASK: CAN.EFF_MASK
    };

    constructor(canId = 0, data = Buffer.alloc(0)) {
        this.#buffer = Buffer.alloc(CAN.FRAME_SIZE);
        this.echoId = 0;
        this.canId = canId;
        this.canDlc = 0;
        this.channel = 0;
        this.flags = 0;
        this.reserved = 0;
        this.data = data;
    }

    get echoId() { return this.#buffer.readUInt32LE(0); }

    set echoId(value) { this.#buffer.writeUInt32LE(value, 0); }

    get canId() { return this.#buffer.readUInt32LE(4); }

    set canId(value) { this.#buffer.writeUInt32LE(value, 4); }

    get canDlc() { return this.#buffer.readUInt8(8); }

    set canDlc(value) { this.#buffer.writeUInt8(Math.min(value, 8), 8); }

    get channel() { return this.#buffer.readUInt8(9); }

    set channel(value) { this.#buffer.writeUInt8(value, 9); }

    get flags() { return this.#buffer.readUInt8(10); }

    set flags(value) { this.#buffer.writeUInt8(value, 10); }

    get reserved() { return this.#buffer.readUInt8(11); }

    set reserved(value) { this.#buffer.writeUInt8(value, 11); }

    get data() { return this.#buffer.subarray(12, 20); }

    set data(value) {
        const buffer = Buffer.isBuffer(value) ? value : 
                      Array.isArray(value) ? Buffer.from(value) :
                      typeof value === 'number' ? Buffer.from([value]) : 
                      Buffer.alloc(0);
        
        buffer.copy(this.#buffer, 12, 0, 8);
        this.canDlc = buffer.length;
    }

    get arbitrationId() { return this.canId & GsUsbFrame.FLAGS.ID_MASK; }

    get isExtendedId() { return Boolean(this.canId & GsUsbFrame.FLAGS.EXTENDED); }

    get isRemoteFrame() { return Boolean(this.canId & GsUsbFrame.FLAGS.REMOTE); }

    get isErrorFrame() { return Boolean(this.canId & GsUsbFrame.FLAGS.ERROR); }

    pack = () => Buffer.from(this.#buffer);

    static unpack(data) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        
        if (buffer.length < CAN.FRAME_SIZE) {
            throw new Error(`Invalid buffer length: ${buffer.length}, expected ${CAN.FRAME_SIZE}`);
        }
    
        const frame = new GsUsbFrame();
        buffer.copy(frame.#buffer, 0, 0, CAN.FRAME_SIZE);
        return frame;
    }

    toString() {
        const dataStr = this.isRemoteFrame ? "remote request" : 
            Buffer.from(this.data.subarray(0, this.canDlc))
                  .toString('hex')
                  .match(/.{2}/g)
                  ?.map(b => b.toUpperCase())
                  .join(' ') || '';
        
        return `ID: ${this.arbitrationId.toString(16).toUpperCase()} | DLC: [${this.canDlc}] | DATA: ${dataStr}`;
    }

    *[Symbol.iterator]() {
        yield* this.data.subarray(0, this.canDlc);
    }
}

export { CAN, GsUsbFrame };
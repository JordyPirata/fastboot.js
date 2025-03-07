import * as Sparse from "./sparse.js";
import * as common from "./common.js";
import { flashZip as flashFactoryZip } from "./factory.js";

const FASTBOOT_USB_CLASS = 0xff;
const FASTBOOT_USB_SUBCLASS = 0x42;
const FASTBOOT_USB_PROTOCOL = 0x03;

const BULK_TRANSFER_SIZE = 16384;

const DEFAULT_DOWNLOAD_SIZE = 512 * 1024 * 1024; // 512 MiB
// To conserve RAM and work around Chromium's ~2 GiB size limit, we limit the
// max download size even if the bootloader can accept more data.
const MAX_DOWNLOAD_SIZE = 1024 * 1024 * 1024; // 1 GiB

const GETVAR_TIMEOUT = 10000; // ms

/**
 * Exception class for USB errors not directly thrown by WebUSB.
 */
export class UsbError extends Error {
    constructor(message) {
        super(message);
        this.name = "UsbError";
    }
}

/**
 * Exception class for errors returned by the bootloader, as well as high-level
 * fastboot errors resulting from bootloader responses.
 */
export class FastbootError extends Error {
    constructor(status, message) {
        super(`Bootloader replied with ${status}: ${message}`);
        this.status = status;
        this.bootloaderMessage = message;
        this.name = "FastbootError";
    }
}

/**
 * This class is a client for executing fastboot commands and operations on a
 * device connected over USB.
 */
export class FastbootDevice {
    /**
     * Create a new fastboot device instance. This doesn't actually connect to
     * any USB devices; call {@link connect} to do so.
     */
    constructor() {
        this.device = null;
        this.epIn = null;
        this.epOut = null;
        this._registeredUsbListeners = false;
        this._connectResolve = null;
        this._connectReject = null;
        this._disconnectResolve = null;
    }

    /**
     * Returns whether a USB device is connected and ready for use.
     */
    get isConnected() {
        return (
            this.device !== null &&
            this.device.opened &&
            this.device.configurations[0].interfaces[0].claimed
        );
    }

    /**
     * Validate the current USB device's details and connect to it.
     *
     * @private
     */
    async _validateAndConnectDevice() {
        // Validate device
        let ife = this.device.configurations[0].interfaces[0].alternates[0];
        if (ife.endpoints.length !== 2) {
            throw new UsbError("Interface has wrong number of endpoints");
        }

        this.epIn = null;
        this.epOut = null;
        for (let endpoint of ife.endpoints) {
            common.logVerbose("Checking endpoint:", endpoint);
            if (endpoint.type !== "bulk") {
                throw new UsbError("Interface endpoint is not bulk");
            }

            if (endpoint.direction === "in") {
                if (this.epIn === null) {
                    this.epIn = endpoint.endpointNumber;
                } else {
                    throw new UsbError("Interface has multiple IN endpoints");
                }
            } else if (endpoint.direction === "out") {
                if (this.epOut === null) {
                    this.epOut = endpoint.endpointNumber;
                } else {
                    throw new UsbError("Interface has multiple OUT endpoints");
                }
            }
        }
        common.logVerbose("Endpoints: in =", this.epIn, ", out =", this.epOut);

        try {
            await this.device.open();
            // Opportunistically reset to fix issues on some platforms
            try {
                await this.device.reset();
            } catch (error) {
                /* Failed = doesn't support reset */
            }

            await this.device.selectConfiguration(1);
            await this.device.claimInterface(0); // fastboot
        } catch (error) {
            // Propagate exception from waitForConnect()
            if (this._connectReject !== null) {
                this._connectReject(error);
                this._connectResolve = null;
                this._connectReject = null;
            }

            throw error;
        }

        // Return from waitForConnect()
        if (this._connectResolve !== null) {
            this._connectResolve();
            this._connectResolve = null;
            this._connectReject = null;
        }
    }

    /**
     * Wait for the current USB device to disconnect, if it's still connected.
     * Returns immediately if no device is connected.
     */
    async waitForDisconnect() {
        if (this.device === null) {
            return;
        }

        return await new Promise((resolve, _reject) => {
            this._disconnectResolve = resolve;
        });
    }

    /**
     * Callback for reconnecting to the USB device.
     * This is necessary because some platforms do not support automatic reconnection,
     * and USB connection requests can only be triggered as the result of explicit
     * user action.
     *
     * @callback ReconnectCallback
     */

    /**
     * Wait for the USB device to connect. Returns at the next connection,
     * regardless of whether the connected USB device matches the previous one.
     *
     * @param {ReconnectCallback} onReconnect - Callback to request device reconnection on Android.
     */
    async waitForConnect(onReconnect = () => {}) {
        // On Android, we need to request the user to reconnect the device manually
        // because there is no support for automatic reconnection.
        if (navigator.userAgent.includes("Android")) {
            await this.waitForDisconnect();
            onReconnect();
        }

        return await new Promise((resolve, reject) => {
            this._connectResolve = resolve;
            this._connectReject = reject;
        });
    }

    /**
     * Request the user to select a USB device and connect to it using the
     * fastboot protocol.
     *
     * @throws {UsbError}
     */
    async connect() {
        let devices = await navigator.usb.getDevices();
        common.logDebug("Found paired USB devices:", devices);
        if (devices.length === 1) {
            this.device = devices[0];
        } else {
            // If multiple paired devices are connected, request the user to
            // select a specific one to reduce ambiguity. This is also necessary
            // if no devices are already paired, i.e. first use.
            common.logDebug(
                "No or multiple paired devices are connected, requesting one"
            );
            this.device = await navigator.usb.requestDevice({
                filters: [
                    {
                        classCode: FASTBOOT_USB_CLASS,
                        subclassCode: FASTBOOT_USB_SUBCLASS,
                        protocolCode: FASTBOOT_USB_PROTOCOL,
                    },
                ],
            });
        }
        common.logDebug("Using USB device:", this.device);

        if (!this._registeredUsbListeners) {
            navigator.usb.addEventListener("disconnect", (event) => {
                if (event.device === this.device) {
                    common.logDebug("USB device disconnected");
                    if (this._disconnectResolve !== null) {
                        this._disconnectResolve();
                        this._disconnectResolve = null;
                    }
                }
            });

            navigator.usb.addEventListener("connect", async (event) => {
                common.logDebug("USB device connected");
                this.device = event.device;

                // Check whether waitForConnect() is pending and save it for later
                let hasPromiseReject = this._connectReject !== null;
                try {
                    await this._validateAndConnectDevice();
                } catch (error) {
                    // Only rethrow errors from the event handler if waitForConnect()
                    // didn't already handle them
                    if (!hasPromiseReject) {
                        throw error;
                    }
                }
            });

            this._registeredUsbListeners = true;
        }

        await this._validateAndConnectDevice();
    }

    /**
     * Read a raw command response from the bootloader.
     *
     * @private
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async _readResponse() {
        let respPacket = await this.device.transferIn(this.epIn, 64);
        let response = new TextDecoder().decode(respPacket.data);

        let respStatus = response.substring(0, 4);
        let data = response.substring(4);
        common.logDebug(`Response: ${respStatus} ${data}`);

        if (respStatus === 'INFO') {
            console.info(data);
         
            return await this._readResponse();
        }
        return [respStatus, data];
    }

    /**
     * Send a textual command to the bootloader.
     * This is in raw fastboot format, not AOSP fastboot syntax.
     *
     * @param {string} command - The command to send.
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async runCommand(command) {
        // Command and response length is always 64 bytes regardless of protocol
        if (command.length > 64) {
            throw new RangeError();
        }

        // Send raw UTF-8 command
        let cmdPacket = new TextEncoder("utf-8").encode(command);
        await this.device.transferOut(this.epOut, cmdPacket);
        common.logDebug("Command:", command);

        return this._readResponse();
    }

    /**
     * Read the value of a bootloader variable. Returns undefined if the variable
     * does not exist.
     *
     * @param {string} varName - The name of the variable to get.
     * @returns {value} Textual content of the variable.
     * @throws {FastbootError}
     */
    async getVariable(varName) {
        let res = await this.runCommand("getvar:" + varName);
        if (res[0] !== "OKAY") {
            console.error(res[1]);
            return undefined;
        }
        return res[1];
    }

    /**
     * Get the maximum download size for a single payload, in bytes.
     *
     * @private
     * @returns {downloadSize}
     * @throws {FastbootError}
     */
    async _getDownloadSize() {
        try {
            let resp = await this.getVariable("max-download-size")
            if (!isNaN(resp) && !isNaN(parseFloat(resp))) {
                resp = parseInt(resp, 10);
                return resp;
            } else {
                resp = parseInt(resp, 16);
                return resp;
            }
            
        } catch (error) {
            /* Failed = no value, fallthrough */
        }

        // FAIL or empty variable means no max, set a reasonable limit to conserve memory
        return DEFAULT_DOWNLOAD_SIZE;
    }

    /**
     * Callback for progress updates while flashing or uploading an image.
     *
     * @callback ProgressCallback
     * @param {number} progress - Progress for the current action, between 0 and 1.
     */

    /**
     * Send a raw data payload to the bootloader.
     *
     * @private
     */
    async _sendRawPayload(data, onProgress = () => {}) {
        const size = data.byteLength;
        const chunksize = 16384;
        let i = 0;
        let left = size;
        while (left > 0) {
            const chunk = data.slice(i * chunksize, (i + 1) * chunksize);
            await this.device.transferOut(1, chunk);
            left -= chunk.byteLength;
            i += 1;
            if (i % 8 === 0) {
                onProgress(1 - (left / size));
            }
        }
        onProgress(1.0);
    }

    /**
     * Upload a payload to the bootloader for further use, e.g. for flashing.
     * Does not handle raw images, flashing, or splitting.
     *
     * @param {string} partition - Name of the partition the payload is intended for.
     * @param {chunkSlit} split - Contains a chunk of the payload to upload.
     * @param {ProgressCallback} onProgress - Callback for upload progress updates.
     * @throws {FastbootError}
     */
    async upload(split, onProgress = () => {}) {

        const size = split.data.byteLength;
        const sizeHex = size.toString(16).padStart(8, "0");

        let res = await this.runCommand('download:' + sizeHex);
        if (res[0] !== 'DATA') {
            console.error('Failed download command', res[1]);
        }
        await this._sendRawPayload(split.data, onProgress);
        return await this._readResponse();
    }

    /**
     * Reboot to the given target, and optionally wait for the device to
     * reconnect.
     *
     * @param {string} target - Where to reboot to, i.e. fastboot or bootloader.
     * @param {boolean} wait - Whether to wait for the device to reconnect.
     * @param {ReconnectCallback} onReconnect - Callback to request device reconnection, if wait is enabled.
     */
    async reboot(target = "", wait = false, onReconnect = () => {}) {
        if (target.length > 0) {
            await this.runCommand(`reboot-${target}`);
        } else {
            await this.runCommand("reboot");
        }

        if (wait) {
            await this.waitForConnect(onReconnect);
        }
    }

    /**
     * Flash the given Blob to the given partition on the device. Any image
     * format supported by the bootloader is allowed, e.g. sparse or raw images.
     * Large raw images will be converted to sparse images automatically, and
     * large sparse images will be split and flashed in multiple passes
     * depending on the bootloader's payload size limit.
     *
     * @param {string} partition - The name of the partition to flash.
     * @param {Reader} reader - The actual image data to flash.
     * @param {ProgressCallback} onProgress - Callback for flashing progress updates.
     * @param {number} rawsize - The size of the raw image in bytes.
     * @throws {FastbootError}
     */
    async flash(partition, reader, rawsize, onProgress = () => {}) {
        const MB = 1024 * 1024;
        let size = rawsize;
        const response = new Response(reader);

        // Use current slot if partition is A/B
        if ((await this.getVariable(`has-slot:${partition}`)) === "yes") {
            partition += "_" + (await this.getVariable("current-slot"));
        }

        let maxDlSize = await this._getDownloadSize();
        common.logDebug(`max-download-size, ${maxDlSize} bytes`);
        
        const blob = await response.blob();

        // Logical partitions need to be resized before flashing because they're
        // sized perfectly to the payload.
        if ((await this.getVariable(`is-logical:${partition}`)) === "yes") {
            // As per AOSP fastboot, we reset the partition to 0 bytes first
            // to optimize extent allocation.
            await this.runCommand(`resize-logical-partition:${partition}:0`);
            // Set the actual size
            await this.runCommand(
                `resize-logical-partition:${partition}:${size}`
            );
        }

        let splits = 0;
        let sentBytes = 0;
        for await (let split of Sparse.splitBlob(blob, Math.max(300 * MB, maxDlSize * 0.8))) {
            await this.upload(split, (progress) => {
                // Convert chunk progress to overall progress
                onProgress((sentBytes + progress * split.bytes) / size);
            });
            await this.runCommand(`flash:${partition}`);
            splits += 1;
            sentBytes += split.bytes;
        }

        common.logDebug(`Flashed ${partition} with ${splits} split(s)`);
    }

    /**
     * Callback for reconnecting the USB device.
     * This is necessary because some platforms do not support automatic reconnection,
     * and USB connection requests can only be triggered as the result of explicit
     * user action.
     *
     * @callback ReconnectCallback
     */

    /**
     * Callback for factory image flashing progress.
     *
     * @callback FactoryFlashCallback
     * @param {string} action - Action in the flashing process, e.g. unpack/flash.
     * @param {string} item - Item processed by the action, e.g. partition being flashed.
     * @param {number} progress - Progress within the current action between 0 and 1.
     */

    /**
     * Flash the given factory images zip onto the device, with automatic handling
     * of firmware, system, and logical partitions as AOSP fastboot and
     * flash-all.sh would do.
     * Equivalent to `fastboot update name.zip`.
     *
     * @param {FastbootDevice} device - Fastboot device to flash.
     * @param {Blob} blob - Blob containing the zip file to flash.
     * @param {boolean} wipe - Whether to wipe super and userdata. Equivalent to `fastboot -w`.
     * @param {ReconnectCallback} onReconnect - Callback to request device reconnection.
     * @param {FactoryFlashCallback} onProgress - Progress callback for image flashing.
     */
    async flashFactoryZip(blob, wipe, onReconnect, onProgress = () => {}) {
        return await flashFactoryZip(this, blob, wipe, onReconnect, onProgress);
    }
}

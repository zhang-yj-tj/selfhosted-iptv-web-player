(function (global) {
  "use strict";

  const DecoderClass = global["mpg123-decoder"]?.MPEGDecoder;
  const AudioContextClass = global.AudioContext || global.webkitAudioContext;
  let sharedAudioContext = null;

  function concatBytes(parts, totalLength) {
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function getPayload(packet) {
    const adaptationControl = (packet[3] >> 4) & 0x03;
    if (adaptationControl === 0 || adaptationControl === 2) return null;
    let offset = 4;
    if (adaptationControl === 3) offset += 1 + packet[4];
    return offset < 188 ? packet.subarray(offset) : null;
  }

  function parsePat(payload) {
    if (!payload?.length) return null;
    const section = payload.subarray(1 + payload[0]);
    if (section[0] !== 0x00) return null;
    const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
    const end = Math.min(section.length, 3 + sectionLength - 4);
    for (let offset = 8; offset + 3 < end; offset += 4) {
      const program = (section[offset] << 8) | section[offset + 1];
      if (program !== 0) return ((section[offset + 2] & 0x1f) << 8) | section[offset + 3];
    }
    return null;
  }

  function parsePmt(payload) {
    if (!payload?.length) return null;
    const section = payload.subarray(1 + payload[0]);
    if (section[0] !== 0x02) return null;
    const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
    const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
    const end = Math.min(section.length, 3 + sectionLength - 4);
    let audioPid = null;
    let audioType = null;
    for (let offset = 12 + programInfoLength; offset + 4 < end;) {
      const streamType = section[offset];
      const pid = ((section[offset + 1] & 0x1f) << 8) | section[offset + 2];
      const infoLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];
      if (streamType === 0x03 || streamType === 0x04) {
        audioPid = pid;
        audioType = streamType;
        break;
      }
      offset += 5 + infoLength;
    }
    return audioPid === null ? null : { audioPid, audioType };
  }

  function crc32Mpeg(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
      }
    }
    return crc >>> 0;
  }

  function stripMpegAudioFromPmt(packet) {
    const payload = getPayload(packet);
    if (!payload?.length || !(packet[1] & 0x40)) return packet;
    const pointer = payload[0];
    const sectionOffset = 1 + pointer;
    const section = payload.subarray(sectionOffset);
    if (section.length < 16 || section[0] !== 0x02) return packet;

    const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
    const sectionEnd = 3 + sectionLength;
    if (sectionEnd > section.length) return packet;
    const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
    const streamsStart = 12 + programInfoLength;
    const streamsEnd = sectionEnd - 4;
    const kept = [];
    let keptLength = 0;
    for (let offset = streamsStart; offset + 4 < streamsEnd;) {
      const streamType = section[offset];
      const infoLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];
      const entryEnd = offset + 5 + infoLength;
      if (entryEnd > streamsEnd) break;
      if (streamType !== 0x03 && streamType !== 0x04) {
        const entry = section.slice(offset, entryEnd);
        kept.push(entry);
        keptLength += entry.length;
      }
      offset = entryEnd;
    }

    const bodyLength = streamsStart + keptLength;
    const rebuilt = new Uint8Array(bodyLength + 4);
    rebuilt.set(section.subarray(0, streamsStart));
    let writeOffset = streamsStart;
    for (const entry of kept) {
      rebuilt.set(entry, writeOffset);
      writeOffset += entry.length;
    }
    const newSectionLength = rebuilt.length - 3;
    rebuilt[1] = (rebuilt[1] & 0xf0) | ((newSectionLength >> 8) & 0x0f);
    rebuilt[2] = newSectionLength & 0xff;
    const crc = crc32Mpeg(rebuilt.subarray(0, rebuilt.length - 4));
    rebuilt[rebuilt.length - 4] = (crc >>> 24) & 0xff;
    rebuilt[rebuilt.length - 3] = (crc >>> 16) & 0xff;
    rebuilt[rebuilt.length - 2] = (crc >>> 8) & 0xff;
    rebuilt[rebuilt.length - 1] = crc & 0xff;

    const output = packet.slice();
    const outputPayload = getPayload(output);
    outputPayload.fill(0xff, sectionOffset);
    outputPayload.set(rebuilt, sectionOffset);
    return output;
  }

  class VideoOnlyTsFilter {
    constructor() {
      this.pending = new Uint8Array(0);
      this.pmtPid = null;
      this.audioPids = new Set();
    }

    push(chunk) {
      let data;
      if (this.pending.length) {
        data = new Uint8Array(this.pending.length + chunk.length);
        data.set(this.pending);
        data.set(chunk, this.pending.length);
      } else {
        data = chunk;
      }
      const packets = [];
      let offset = 0;
      while (offset + 188 <= data.length) {
        if (data[offset] !== 0x47) {
          const nextSync = data.indexOf(0x47, offset + 1);
          if (nextSync < 0) break;
          offset = nextSync;
          continue;
        }
        let packet = data.subarray(offset, offset + 188);
        const payloadStart = Boolean(packet[1] & 0x40);
        const pid = ((packet[1] & 0x1f) << 8) | packet[2];
        const payload = getPayload(packet);
        if (pid === 0 && payloadStart) {
          const pmtPid = parsePat(payload);
          if (pmtPid !== null) this.pmtPid = pmtPid;
        } else if (pid === this.pmtPid && payloadStart) {
          const stream = parsePmt(payload);
          if (stream) this.audioPids.add(stream.audioPid);
          packet = stripMpegAudioFromPmt(packet);
        }
        if (!this.audioPids.has(pid)) packets.push(packet);
        offset += 188;
      }
      this.pending = data.slice(offset);
      if (!packets.length) return null;
      const output = new Uint8Array(packets.length * 188);
      packets.forEach((packet, index) => output.set(packet, index * 188));
      return output;
    }
  }

  class SharedAudioFetchLoader extends global.mpegts.BaseLoader {
    static isSupported() {
      return Boolean(global.fetch && global.ReadableStream && global.AbortController);
    }

    constructor(_seekHandler, config) {
      super("shared-audio-fetch-loader");
      this.config = config;
      this.bridge = config.audioBridge || null;
      this.controller = null;
      this.receivedLength = 0;
      this.deliveredLength = 0;
      this.range = null;
      this.videoFilter = new VideoOnlyTsFilter();
      this._needStash = true;
    }

    open(dataSource, range) {
      this.range = range;
      this.receivedLength = 0;
      this.deliveredLength = 0;
      this.videoFilter = new VideoOnlyTsFilter();
      this.controller = new AbortController();
      this._status = global.mpegts.LoaderStatus.kConnecting;
      const headers = new Headers(this.config.headers || {});
      fetch(dataSource.url, {
        method: "GET",
        headers,
        mode: dataSource.cors === false ? "same-origin" : "cors",
        credentials: dataSource.withCredentials ? "include" : "omit",
        cache: "no-store",
        signal: this.controller.signal,
        referrerPolicy: dataSource.referrerPolicy || "no-referrer-when-downgrade",
      }).then(async (response) => {
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        if (response.url !== dataSource.url && this._onURLRedirect) this._onURLRedirect(response.url);
        const contentLength = Number(response.headers.get("Content-Length"));
        if (contentLength > 0 && this._onContentLengthKnown) this._onContentLengthKnown(contentLength);
        const reader = response.body.getReader();
        while (!this.controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) {
            this._status = global.mpegts.LoaderStatus.kComplete;
            if (this._onComplete) this._onComplete(range.from, range.from + this.receivedLength - 1);
            return;
          }
          this._status = global.mpegts.LoaderStatus.kBuffering;
          this.bridge?.pushTs(value);
          this.receivedLength += value.byteLength;
          const videoOnly = this.videoFilter.push(value);
          if (videoOnly?.length) {
            const chunk = videoOnly.buffer.slice(videoOnly.byteOffset, videoOnly.byteOffset + videoOnly.byteLength);
            const byteStart = range.from + this.deliveredLength;
            this.deliveredLength += videoOnly.byteLength;
            this._onDataArrival?.(chunk, byteStart, this.deliveredLength);
          }
        }
      }).catch((error) => {
        if (this.controller?.signal.aborted) return;
        this._status = global.mpegts.LoaderStatus.kError;
        this._onError?.(global.mpegts.LoaderErrors.EXCEPTION, { code: -1, msg: error.message });
      });
    }

    abort() {
      this.controller?.abort();
      this._status = global.mpegts.LoaderStatus.kIdle;
    }

    destroy() {
      this.abort();
      this.bridge = null;
      super.destroy();
    }
  }

  class MPEGAudioBridge {
    constructor(options) {
      this.mediaElement = options.mediaElement;
      this.onStatus = options.onStatus || (() => {});
      this.onError = options.onError || (() => {});
      this.decoder = null;
      this.context = null;
      this.gain = null;
      this.pmtPid = null;
      this.audioPid = null;
      this.pendingTs = new Uint8Array(0);
      this.audioParts = [];
      this.audioLength = 0;
      this.decodeQueue = Promise.resolve();
      this.pcmQueue = [];
      this.pcmQueueDuration = 0;
      this.nextStartTime = 0;
      this.sources = new Set();
      this.destroyed = false;
      this.audioStarted = false;
      this.handlePlaying = () => this.resume();
      this.handlePause = () => this.pause();
      this.handleVolume = () => this.syncVolume();
    }

    async start() {
      if (!DecoderClass || !AudioContextClass) throw new Error("浏览器缺少 MPEG 音频解码能力");
      this.context = sharedAudioContext || (sharedAudioContext = new AudioContextClass({ latencyHint: "interactive" }));
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.syncVolume();
      this.mediaElement.addEventListener("playing", this.handlePlaying);
      this.mediaElement.addEventListener("pause", this.handlePause);
      this.mediaElement.addEventListener("volumechange", this.handleVolume);
      await this.context.resume();

      this.decoder = new DecoderClass({ enableGapless: false });
      await this.decoder.ready;
      if (this.destroyed) return;
      this.onStatus("音频解码器已就绪");
    }

    pushTs(chunk) {
      let data;
      if (this.pendingTs.length) {
        data = new Uint8Array(this.pendingTs.length + chunk.length);
        data.set(this.pendingTs);
        data.set(chunk, this.pendingTs.length);
      } else {
        data = chunk;
      }

      let offset = 0;
      while (offset + 188 <= data.length) {
        if (data[offset] !== 0x47) {
          const nextSync = data.indexOf(0x47, offset + 1);
          if (nextSync < 0) break;
          offset = nextSync;
          continue;
        }
        this.pushPacket(data.subarray(offset, offset + 188));
        offset += 188;
      }
      this.pendingTs = data.slice(offset);
    }

    pushPacket(packet) {
      const payloadStart = Boolean(packet[1] & 0x40);
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      const payload = getPayload(packet);
      if (!payload) return;

      if (pid === 0 && payloadStart) {
        const pmtPid = parsePat(payload);
        if (pmtPid !== null) this.pmtPid = pmtPid;
        return;
      }
      if (pid === this.pmtPid && payloadStart) {
        const stream = parsePmt(payload);
        if (stream) {
          this.audioPid = stream.audioPid;
          this.onStatus("已识别 MPEG 音轨");
        }
        return;
      }
      if (pid !== this.audioPid) return;

      let elementary = payload;
      if (payloadStart && payload.length >= 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
        const headerLength = payload[8];
        elementary = payload.subarray(Math.min(payload.length, 9 + headerLength));
      }
      if (!elementary.length) return;
      this.audioParts.push(elementary.slice());
      this.audioLength += elementary.length;
      if (this.audioLength >= 8192) this.flushAudio();
    }

    flushAudio() {
      if (!this.audioLength || !this.decoder) return;
      const bytes = concatBytes(this.audioParts, this.audioLength);
      this.audioParts = [];
      this.audioLength = 0;
      this.decodeQueue = this.decodeQueue
        .then(() => {
          if (this.destroyed) return;
          const decoded = this.decoder.decode(bytes);
          if (decoded.samplesDecoded > 0) this.enqueuePcm(decoded);
        })
        .catch((error) => {
          if (!this.destroyed) this.onError(error);
        });
    }

    enqueuePcm(decoded) {
      const duration = decoded.samplesDecoded / decoded.sampleRate;
      const item = { channelData: decoded.channelData, samples: decoded.samplesDecoded, sampleRate: decoded.sampleRate, duration };
      if (this.mediaElement.paused || this.mediaElement.readyState === 0) {
        this.pcmQueue.push(item);
        this.pcmQueueDuration += duration;
        while (this.pcmQueueDuration > 0.8 && this.pcmQueue.length > 1) {
          this.pcmQueueDuration -= this.pcmQueue.shift().duration;
        }
        return;
      }
      this.schedule(item);
    }

    schedule(item) {
      if (this.destroyed || !this.context || !this.gain) return;
      const now = this.context.currentTime;
      if (this.nextStartTime < now + 0.04) this.nextStartTime = now + 0.08;
      if (this.nextStartTime - now > 0.9) return;

      const channelCount = Math.min(2, item.channelData.length);
      const buffer = this.context.createBuffer(channelCount, item.samples, item.sampleRate);
      for (let channel = 0; channel < channelCount; channel += 1) {
        buffer.copyToChannel(item.channelData[channel], channel);
      }
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = Math.max(0.95, Math.min(1.05, this.mediaElement.playbackRate || 1));
      source.connect(this.gain);
      source.onended = () => this.sources.delete(source);
      this.sources.add(source);
      source.start(this.nextStartTime);
      this.nextStartTime += durationWithRate(item.duration, source.playbackRate.value);
      if (!this.audioStarted) {
        this.audioStarted = true;
        this.onStatus("MPEG 音频播放中");
      }
    }

    resume() {
      if (this.destroyed || !this.context) return;
      this.context.resume().catch(() => {});
      const queued = this.pcmQueue.splice(0);
      this.pcmQueueDuration = 0;
      for (const item of queued) this.schedule(item);
    }

    pause() {
      if (!this.context || this.destroyed) return;
      this.context.suspend().catch(() => {});
    }

    syncVolume() {
      if (!this.gain) return;
      const value = this.mediaElement.muted ? 0 : this.mediaElement.volume;
      this.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.015);
    }

    async destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.mediaElement.removeEventListener("playing", this.handlePlaying);
      this.mediaElement.removeEventListener("pause", this.handlePause);
      this.mediaElement.removeEventListener("volumechange", this.handleVolume);
      for (const source of this.sources) {
        try { source.stop(); } catch {}
      }
      this.sources.clear();
      this.gain?.disconnect();
      try { this.decoder?.free(); } catch {}
    }
  }

  function durationWithRate(duration, rate) {
    return duration / rate;
  }

  global.IPTVAudio = {
    Loader: SharedAudioFetchLoader,
    create(options) {
      const bridge = new MPEGAudioBridge(options);
      bridge.start().catch((error) => {
        if (error?.name !== "AbortError" && !bridge.destroyed) bridge.onError(error);
      });
      return bridge;
    }
  };
})(window);

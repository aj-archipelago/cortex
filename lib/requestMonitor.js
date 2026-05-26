import { v4 as uuidv4 } from 'uuid';
import { Deque } from '@datastructures-js/deque';

class RequestMonitor {
  constructor( callsToKeep = 10 ) {
    this.callCount = new Deque();
    this.peakCallRate = 0;
    this.error429Count = new Deque();
    this.errorCount = new Deque();
    this.startTime = new Date();
    this.callStartTimes = new Map();
    this.callDurations = new Deque();
    this.ttfbDurations = new Deque();
    this.pingCallDurations = new Deque();
    this.pingTtfbDurations = new Deque();
    this.lastSampleAt = 0;
    this.lastPingSampleAt = 0;
    this.healthy = true;
    this.ageOutTime = 5 * 60 * 1000; // 5 minutes
    this.callsToKeep = callsToKeep;
  }

  get isHealthy() {
    return this.healthy;
  }

  removeOldCallStarts() {
    const currentTime = new Date();
    for (const [callId, startTime] of this.callStartTimes) {
      if (currentTime - startTime > this.ageOutTime) {
        this.callStartTimes.delete(callId);
      }
    }
  }

  removeOldCallStats(dq, timeProperty) {
    const currentTime = new Date();
    while (!dq.isEmpty() && currentTime - (timeProperty ? dq.front()[timeProperty] : dq.front())  > this.ageOutTime) {
      dq.popFront();
    }
  }
  
  maintain() {
    this.removeOldCallStarts();
    this.removeOldCallStats(this.callCount);
    if (this.callCount.size() === 0) {
      this.peakCallRate = 0;
    }
    // Latency samples (callDurations, ttfbDurations) are intentionally NOT
    // aged out. They are bounded by callsToKeep so memory stays small, and a
    // stale latency reading is still the picker's best estimate. Aging them
    // out causes idle members to drop out of selection between sampler
    // cycles, after which pickGroupMember falls back to priority-1 — which
    // has nothing to do with current speed.
    this.removeOldCallStats(this.error429Count);
    this.removeOldCallStats(this.errorCount);

    if (this.getErrorRate() > 0.1) {
      this.healthy = false;
    } else {
      this.healthy = true;
    }
  }

  startCall() {
    const callId = uuidv4();
    const currentTime = new Date();
    this.callStartTimes.set(callId, currentTime);
    this.callCount.pushBack(currentTime);
    this.maintain();
    return callId;
  }

  trimSamples(dq) {
    while (dq.size() > this.callsToKeep) {
      dq.popFront();
    }
  }

  endCall(callId, source = 'live') {
    const endTime = new Date();
    const startTime = this.callStartTimes.get(callId);
    let callDuration = null;

    if (startTime) {
      callDuration = (endTime - startTime);
      this.callStartTimes.delete(callId);
      if (source === 'ping') {
        this.pingCallDurations.pushBack({endTime, callDuration});
        this.lastPingSampleAt = endTime.getTime();
      } else {
        this.callDurations.pushBack({endTime, callDuration});
        this.lastSampleAt = endTime.getTime();
      }

      this.trimSamples(this.callDurations);
      this.trimSamples(this.pingCallDurations);
    }

    const callRate = this.getCallRate();
    if (callRate > this.peakCallRate) {
      this.peakCallRate = callRate;
    }
    
    this.maintain();
    return callDuration;
  }

  getAverageCallDuration(source = null) {
    this.maintain();
    const durations = source === 'ping' ? this.pingCallDurations : this.callDurations;
    if (durations.size() === 0) {
      return 0;
    }
    const sum = durations.toArray().reduce((a, b) => a + b.callDuration, 0);
    return sum / durations.size();
  }

  recordTTFB(ttfbMs, source = 'live') {
    if (typeof ttfbMs !== 'number' || !Number.isFinite(ttfbMs) || ttfbMs < 0) return;
    const recordedAt = new Date();
    if (source === 'ping') {
      this.pingTtfbDurations.pushBack({ recordedAt, ttfb: ttfbMs });
      this.lastPingSampleAt = recordedAt.getTime();
    } else {
      this.ttfbDurations.pushBack({ recordedAt, ttfb: ttfbMs });
      this.lastSampleAt = recordedAt.getTime();
    }
    this.trimSamples(this.ttfbDurations);
    this.trimSamples(this.pingTtfbDurations);
  }

  getAverageTTFB(source = null) {
    this.maintain();
    const durations = source === 'ping' ? this.pingTtfbDurations : this.ttfbDurations;
    if (durations.size() === 0) return 0;
    const sum = durations.toArray().reduce((a, b) => a + b.ttfb, 0);
    return sum / durations.size();
  }

  getSampleAge(source = null) {
    const sampleAt = source === 'ping' ? this.lastPingSampleAt : this.lastSampleAt;
    return sampleAt ? (Date.now() - sampleAt) : Infinity;
  }

  incrementErrorCount(callId, status, source = 'live') {
    this.errorCount.pushBack(new Date());
    if (status === 429) {
      this.error429Count.pushBack(new Date());
    }
    this.maintain();
    return callId ? this.endCall(callId, source) : null;
  }

  getCallRate() {
    this.maintain();
    const currentTime = new Date();
    const timeElapsed = (currentTime - this.callCount.front()) / 1000; // time elapsed in seconds]
    return timeElapsed < 1 ? this.callCount.size() : this.callCount.size() / timeElapsed;
  }

  getPeakCallRate() {
    this.maintain();
    return this.peakCallRate;
  }

  getError429Rate() {
    return this.callCount.size() ? this.error429Count.size() / this.callCount.size() : 0;
  }

  getErrorRate() {
    return this.callCount.size() ? this.errorCount.size() / this.callCount.size() : 0;
  }

  calculatePercentComplete(callId) {
    if (!this.callDurations.size()) {
      return 0;
    }
  
    const currentTime = new Date();
    const duration = currentTime - this.callStartTimes.get(callId);
    const average = this.getAverageCallDuration();
    let percentComplete = duration / average;
  
    if (percentComplete > 0.8) {
      percentComplete = 0.8;
    }
  
    return percentComplete;
  }

  reset() {
    this.callCount.clear();
    this.peakCallRate = 0;
    this.error429Count.clear();
    this.errorCount.clear();
    this.startTime = new Date();
    this.callStartTimes = new Map();
    this.callDurations.clear();
    this.ttfbDurations.clear();
    this.pingCallDurations.clear();
    this.pingTtfbDurations.clear();
    this.lastSampleAt = 0;
    this.lastPingSampleAt = 0;
    this.healthy = true;
  }
}

export default RequestMonitor;

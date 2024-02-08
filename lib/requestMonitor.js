import { v4 as uuidv4 } from 'uuid';

class RequestMonitor {
  constructor() {
    this.callCount = [];
    this.peakCallRate = 0;
    this.error429Count = [];
    this.error500Count = [];
    this.startTime = new Date();
    this.callStartTimes = new Map();
    this.callDurations = [];
    this.healthy = true;
    this.ageOutTime = 1 * 60 * 1000; // 1 minutes
  }

  get isHealthy() {
    return this.healthy;
  }

  startCall() {
    const callId = uuidv4();
    const currentTime = new Date();
    this.callStartTimes.set(callId, currentTime);
    this.callCount.push(currentTime);
    return callId;
  }

  removeOldCallStats() {
    const currentTime = new Date();
    for (const [callId, startTime] of this.callStartTimes) {
      if (currentTime - startTime > this.ageOutTime) {
        this.callStartTimes.delete(callId);
      }
    }
    for (let i = 0; i < this.error429Count.length; i++) {
      if (currentTime - this.error429Count[i] > this.ageOutTime) {
        this.error429Count.splice(i, 1);
        i--;
      }
    }
    for (let i = 0; i < this.error500Count.length; i++) {
      if (currentTime - this.error500Count[i] > this.ageOutTime) {
        this.error500Count.splice(i, 1);
        i--;
      }
    }
    for (let i = 0; i < this.callCount.length; i++) {
      if (currentTime - this.callCount[i] > this.ageOutTime) {
        this.callCount.splice(i, 1);
        i--;
      }
    } 
  }

  endCall(callId) {
    const endTime = new Date();
    const startTime = this.callStartTimes.get(callId);

    if (startTime) {
      this.callStartTimes.delete(callId);
      const callDuration = endTime - startTime;
      this.callDurations.push(callDuration);

      // Keep the callDurations length to 5
      while (this.callDurations.length > 5) {
        this.callDurations.shift();
      }
    }

    if (this.getCallRate() > this.peakCallRate) {
      this.peakCallRate = this.getCallRate();
    }

    this.removeOldCallStats();

    if ((this.getError429Rate() > 0.3) || (this.getError500Rate() > 0.3)) {
      this.healthy = false;
    } else {
      this.healthy = true;
    }
  }

  getAverageCallDuration() {
    if (this.callDurations.length === 0) {
      return 0;
    }
    const sum = this.callDurations.reduce((a, b) => a + b, 0);
    return sum / this.callDurations.length; 
  }

  incrementError429Count() {
    this.error429Count.push(new Date());
  }

  incrementError500Count() {
    this.error500Count.push(new Date());
  }

  getCallRate() {
    const currentTime = new Date();
    const timeElapsed = (currentTime - this.callCount[0]) / 1000; // time elapsed in seconds
    return timeElapsed < 1 ? this.callCount.length : this.callCount.length / timeElapsed;
  }

  getPeakCallRate() {
    return this.peakCallRate;
  }

  getError429Rate() {
    return this.error429Count.length / this.callCount.length;
  }

  getError500Rate() {
    return this.error500Count.length / this.callCount.length;
  }

  reset() {
    this.callCount = [];
    this.peakCallRate = 0;
    this.error429Count = [];
    this.error500Count = [];
    this.startTime = new Date();
    this.callStartTimes = new Map();
    this.callDurations = [];
    this.healthy = true;
  }
}

export default RequestMonitor;
  
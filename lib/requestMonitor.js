import { v4 as uuidv4 } from 'uuid';
// eslint-disable-next-line import/no-extraneous-dependencies
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
    this.healthy = true;
    this.ageOutTime = 5 * 60 * 1000; // 5 minutes
    this.callsToKeep = callsToKeep;
  }

  get isHealthy() {
    return this.healthy;
  }

  removeOldCallStats(dq, timeProperty) {
    const currentTime = new Date();
    while (!dq.isEmpty() && currentTime - (timeProperty ? dq.front()[timeProperty] : dq.front())  > this.ageOutTime) {
      dq.popFront();
    }
  }
  
  maintain() {
    this.removeOldCallStats(this.callCount);
    if (this.callCount.size() === 0) {
      this.peakCallRate = 0;
    }
    this.removeOldCallStats(this.callDurations, 'endTime');
    this.removeOldCallStats(this.error429Count);
    this.removeOldCallStats(this.errorCount);
  
    if (this.getErrorRate() > 0.3) {
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

  endCall(callId) {
    const endTime = new Date();
    const startTime = this.callStartTimes.get(callId);

    if (startTime) {
      this.callStartTimes.delete(callId);
      const callDuration = endTime - startTime;
      this.callDurations.pushBack({endTime, callDuration});

      // Keep the callDurations length to 5
      while (this.callDurations.size() > this.callsToKeep) {
        this.callDurations.popFront();
      }
    }

    const callRate = this.getCallRate();
    if (callRate > this.peakCallRate) {
      this.peakCallRate = callRate;
    }
    
    this.maintain();
  }

  getAverageCallDuration() {
    this.maintain();
    if (this.callDurations.size() === 0) {
      return 0;
    }
    const sum = this.callDurations.toArray().reduce((a, b) => a + b.callDuration, 0);
    return sum / this.callDurations.size(); 
  }

  incrementError429Count() {
    this.error429Count.pushBack(new Date());
    this.maintain();
  }

  incrementErrorCount() {
    this.errorCount.pushBack(new Date());
    this.maintain();
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
    this.healthy = true;
  }
}

export default RequestMonitor;
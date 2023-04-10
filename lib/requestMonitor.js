class RequestMonitor {
    constructor() {
      this.callCount = 0;
      this.peakCallRate = 0;
      this.error429Count = 0;
      this.startTime = new Date();
    }
  
    incrementCallCount() {
      this.callCount++;
      if (this.getCallRate() > this.peakCallRate) {
        this.peakCallRate = this.getCallRate();
      }
    }
  
    incrementError429Count() {
      this.error429Count++;
    }
  
    getCallRate() {
      const currentTime = new Date();
      const timeElapsed = (currentTime - this.startTime) / 1000; // time elapsed in seconds
      return timeElapsed < 1 ? this.callCount : this.callCount / timeElapsed;
    }

    getPeakCallRate() {
      return this.peakCallRate;
    }
  
    getError429Rate() {
      return this.error429Count / this.callCount;
    }
  
    reset() {
      this.callCount = 0;
      this.error429Count = 0;
      this.peakCallRate = 0;
      this.startTime = new Date();
    }
  }

export default RequestMonitor;
  
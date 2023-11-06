/**
 * A class to get request durations and estimate their average.
 */
export default class RequestDurationEstimator {
    // Initializing the class with given number of durations to track.
    constructor(n = 10) {
        this.n = n;  // Number of last durations to consider
        this.durations = [];  // List to keep track of last n durations
    }

    /**
     * Private method to add a request duration to the durations list.
     * If the list is full (n durations already), the oldest duration is removed.
     * @param {number} duration - The duration of the request
     */
    #add(duration) {
        this.durations.push(duration);
        // Remove the oldest duration if we have stored n durations
        if (this.durations.length > this.n) {
            this.durations.shift();
        }
    }

    /**
     * To be invoked when a request starts.
     * If there is an ongoing request, it ends that request.
     * @param {string} requestId - The ID of the request
     */
    startRequest(requestId) {
        // If there is an ongoing request, end it
        if (this.requestId) {
            this.endRequest();
        }

        // Store the starting details of the new request
        this.requestId = requestId;
        this.startTime = Date.now();
    }

    /**
     * To be invoked when a request ends.
     * Calculates the duration of the request and adds it to the durations list.
     */
    endRequest() {
        // If there is an ongoing request, add its duration to the durations list
        if (this.requestId) {
            this.#add(Date.now() - this.startTime);
            this.requestId = null;
        }
    }

    /**
     * Calculate and return the average of the request durations.
     * @return {number} The average request duration
     */
    getAverage() {
        // If no duration is stored, return 0
        if (!this.durations.length) {
            return 0;
        }

        // Calculate the sum of the durations and divide by the number of durations to get the average
        return this.durations.reduce((a, b) => a + b) / this.durations.length;
    }

    /**
     * Calculate the percentage completion of the current request based on the average of past durations.
     * @return {number} The estimated percent completion of the ongoing request
     */
    calculatePercentComplete() {
        // If no duration is stored, return 0
        if (!this.durations.length) {
            return 0;
        }


        // Calculate the duration of the current request
        const duration = Date.now() - this.startTime;
        // Get the average of the durations
        const average = this.getAverage();
        // Calculate the percentage completion
        let percentComplete = duration / average;

        if (percentComplete > .8) {
            percentComplete = 0.8;
        }

        return percentComplete;
    }
}
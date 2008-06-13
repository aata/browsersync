/**
 * Encapsulates a list of jobs which need to be performed and runs each one in 
 * turn until no more jobs are left. Jobs are represented as functions which 
 * take no arguments. To make such functions conveniently, see bind() and 
 * partial().
 *
 * Because JavaScript that runs too long without yielding can make the UI
 * unresponsive, WorkQueue periodically rests to give the UI time to update, 
 * then resumes where it left off.
 *
 * Example Usage:
 *
 * var wq = new G_WorkQueue();
 * wq.maxRunTime = 500; // defaults to 200
 * wq.pauseTime = 200; // defaults to 0 (resume as soon as possible)
 * wq.onError = function(nextJob, e) { // defaults to rethrowing the error
 *   myLogFunction(e);
 * }
 * wq.addJob(partial(countToOneMillion, 1));
 *
 * function countToOneMillion(count) {
 *   if (count > 1000000) {
 *     alert("whee! we're done!");
 *     return;
 *   }
 *
 *   log(count);
 *
 *   wq.addJob(partial(countToOneMillion, count + 1));
 * }
 */
function G_WorkQueue() {
  bindMethods(this);
  
  this.maxRunTime = G_WorkQueue.defaultMaxRunTime;
  this.pauseTime = G_WorkQueue.defaultPauseTime;
  this.queue_ = [];
  this.running_ = false;

  // figure out which timeout method to use.
  // TODO(aa): It would be nice to write a wrapper for setTimeout/setInterval
  // that has the same interface as firefox/javascript/alarm so that we could
  // just use whichever G_Alarm is defined.
  if (G_WorkQueue.global_.G_Alarm) {
    this.scheduleResume_ = this.scheduleAlarmResume_;
  } else {
    this.scheduleResume_ = this.scheduleTimeoutResume_;
  }
}

G_WorkQueue.defaultMaxRunTime = 200;
G_WorkQueue.defaultPauseTime = 0;

// Required to be able to test for existence of G_Alarm.
G_WorkQueue.global_ = this;

/**
 * Adds a job to the workqueue. The first such call starts the queue running.
 */
G_WorkQueue.prototype.addJob = function(jobFn) {
  this.queue_.push(jobFn);

  if (!this.running_) {
    this.running_ = true;
    this.resume_();
  }
}

/**
 * Stop running jobs. onError is not called.
 */
G_WorkQueue.prototype.cancel = function() {
  // First cancel any scheduled run
  if (this.alarm_) {
    this.alarm_.cancel();
  } else if (this.timerID_) {
    window.clearTimeout(this.timerID_);
  }

  // Next cancel things currently running
  this.running_ = false;
}

/**
 * Default error handler. Users can override to do something else with errors.
 */
G_WorkQueue.prototype.onError = function(failedJob, e) {
  throw e;
}

/**
 * Starts the workqueue processing again after it has been yielding.
 */
G_WorkQueue.prototype.resume_ = function() {
  this.alarm_ = null;
  this.timerID_ = null;

  this.batchStart_ = new Date().getTime();
  var nextJob;
    
  while ((nextJob = this.queue_[0]) && this.running_) {
    if (new Date() - this.batchStart_ > this.maxRunTime) {
      this.scheduleResume_();
      return;
    }
    
    try {
      nextJob();
    } catch (e) {
      this.onError(nextJob, e);
    }

    this.queue_.shift();
  }

  this.running_ = false;
}

/**
 * Helper to schedule resume with G_Alarm. This is used if G_Alarm is defined.
 */
G_WorkQueue.prototype.scheduleAlarmResume_ = function() {
  this.alarm_ = new G_Alarm(this.resume_, this.pauseTime);
}

/**
 * Helper to schedule resume with window.setTimeout. This is used as a fallback
 * if G_Alarm is not defined.
 */
G_WorkQueue.prototype.scheduleTimeoutResume_ = function() {
  this.timerID_ = window.setTimeout(this.resume_, this.pauseTime);
}

'use strict';

let _stop = false;

class StopError extends Error {
  constructor() {
    super('STOP_REQUESTED');
    this.name = 'StopError';
  }
}

module.exports = {
  request: () => { _stop = true; },
  reset:   () => { _stop = false; },
  check:   () => { if (_stop) throw new StopError(); },
  isSet:   () => _stop,
  StopError,
};

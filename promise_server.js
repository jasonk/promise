var assert = require("assert");
var fiberPool = require("./fiber_pool.js").makePool();
var MeteorPromise = require("./promise.js");

// Replace MeteorPromise.prototype.then with a wrapper that ensures the
// onResolved and onRejected callbacks always run in a Fiber.
var es6PromiseThen = MeteorPromise.prototype.then;
MeteorPromise.prototype.then = function (onResolved, onRejected) {
  var Promise = this.constructor;

  if (typeof Promise.Fiber === "function") {
    var fiber = Promise.Fiber.current;
    var dynamics = cloneFiberOwnProperties(fiber);

    return es6PromiseThen.call(
      this,
      wrapCallback(onResolved, Promise, dynamics),
      wrapCallback(onRejected, Promise, dynamics)
    );
  }

  return es6PromiseThen.call(this, onResolved, onRejected);
};

function wrapCallback(callback, Promise, dynamics) {
  if (! callback) {
    return callback;
  }

  return function (arg) {
    return fiberPool.run({
      callback: callback,
      args: [arg], // Avoid dealing with arguments objects.
      dynamics: dynamics
    }, Promise);
  };
}

function cloneFiberOwnProperties(fiber) {
  if (fiber) {
    var dynamics = {};

    Object.keys(fiber).forEach(function (key) {
      dynamics[key] = shallowClone(fiber[key]);
    });

    return dynamics;
  }
}

function shallowClone(value) {
  if (Array.isArray(value)) {
    return value.slice(0);
  }

  if (value && typeof value === "object") {
    var copy = Object.create(Object.getPrototypeOf(value));
    var keys = Object.keys(value);
    var keyCount = keys.length;

    for (var i = 0; i < keyCount; ++i) {
      var key = keys[i];
      copy[key] = value[key];
    }

    return copy;
  }

  return value;
}

// Yield the current Fiber until the given Promise has been fulfilled.
function awaitPromise(promise) {
  var Promise = promise.constructor;
  var Fiber = Promise.Fiber;

  assert.strictEqual(
    typeof Fiber, "function",
    "Cannot await unless Promise.Fiber is defined"
  );

  var fiber = Fiber.current;

  assert.ok(
    fiber instanceof Fiber,
    "Cannot await without a Fiber"
  );

  var run = fiber.run;
  var throwInto = fiber.throwInto;

  if (process.domain) {
    run = process.domain.bind(run);
    throwInto = process.domain.bind(throwInto);
  }

  // The overridden es6PromiseThen function is adequate here because these
  // two callbacks do not need to run in a Fiber.
  es6PromiseThen.call(promise, function (result) {
    tryCatchNextTick(fiber, run, [result]);
  }, function (error) {
    tryCatchNextTick(fiber, throwInto, [error]);
  });

  return Fiber.yield();
}

// Invoke method with args against object in a try-catch block,
// re-throwing any exceptions in the next tick of the event loop, so that
// they won't get captured/swallowed by the caller.
function tryCatchNextTick(object, method, args) {
  try {
    return method.apply(object, args);
  } catch (error) {
    process.nextTick(function () {
      throw error;
    });
  }
}

MeteorPromise.awaitAll = function (args) {
  return awaitPromise(this.all(args));
};

MeteorPromise.await = function (arg) {
  return awaitPromise(this.resolve(arg));
};

MeteorPromise.prototype.await = function () {
  return awaitPromise(this);
};

// Return a wrapper function that returns a Promise for the eventual
// result of the original function.
MeteorPromise.async = function (fn, allowReuseOfCurrentFiber) {
  var Promise = this;
  return function () {
    return Promise.asyncApply(
      fn, this, arguments,
      allowReuseOfCurrentFiber
    );
  };
};

MeteorPromise.asyncApply = function (
  fn, context, args, allowReuseOfCurrentFiber
) {
  var Promise = this;
  var Fiber = Promise.Fiber;
  var fiber = Fiber && Fiber.current;

  if (fiber && allowReuseOfCurrentFiber) {
    return this.resolve(fn.apply(context, args));
  }

  return fiberPool.run({
    callback: fn,
    context: context,
    args: args,
    dynamics: cloneFiberOwnProperties(fiber)
  }, Promise);
};

Function.prototype.async = function (allowReuseOfCurrentFiber) {
  return MeteorPromise.async(this, allowReuseOfCurrentFiber);
};

Function.prototype.asyncApply = function (
  context, args, allowReuseOfCurrentFiber
) {
  return MeteorPromise.asyncApply(
    this, context, args, allowReuseOfCurrentFiber
  );
};

module.exports = exports = MeteorPromise;

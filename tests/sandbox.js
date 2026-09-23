// tests/sandbox.js
// Loads server/server.js the same way FDK's local server does: inside a
// vm context whose only globals are the ones the platform injects
// ($request, $db, renderData, require, console). Anything that works here
// works under `fdk run`; anything that does not - a stray `module.exports`,
// an unhandled rejection - fails here first.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER_ROOT = path.resolve(__dirname, '..', 'server');

function createDb() {
  const rows = new Map();

  return {
    rows,
    api: {
      get(key) {
        if (!rows.has(key)) {
          return Promise.reject({ status: 404, message: 'Record not found' });
        }
        return Promise.resolve(rows.get(key));
      },
      set(key, value) {
        rows.set(key, JSON.parse(JSON.stringify(value)));
        return Promise.resolve({ Created: true });
      }
    }
  };
}

// Mirrors framework.js: relative requires resolve inside server/ only, the
// ".js" suffix is added for you, and each module is executed in the same
// context with a fresh `exports` object that the module is expected to assign.
function loadServer(globals) {
  const db = createDb();
  const nestedPath = [`${SERVER_ROOT}/`];
  const cache = {};
  let context = null;

  function run(source) {
    const wrapped = `(function() {var exports = {};\n${source};\nreturn exports;\n})()`;

    return new vm.Script(wrapped, { filename: 'server.js' }).runInContext(context);
  }

  const sandbox = Object.assign({
    exports: {},
    console,
    $db: db.api,
    process: { cwd: () => SERVER_ROOT, env: {} },
    require(relativePath) {
      const basePath = path.resolve.apply(null, nestedPath);
      const fullPath = path.normalize(`${basePath}/${relativePath}.js`);

      if (Object.prototype.hasOwnProperty.call(cache, fullPath)) {
        return cache[fullPath];
      }

      if (!fullPath.startsWith(SERVER_ROOT) || !fs.existsSync(fullPath)) {
        throw new Error(`Cannot find module "${relativePath}"`);
      }

      nestedPath.push(path.dirname(relativePath));
      cache[fullPath] = run(fs.readFileSync(fullPath, 'utf8'));
      nestedPath.pop();

      return cache[fullPath];
    }
  }, globals);

  sandbox.global = sandbox;
  context = vm.createContext(sandbox);

  return {
    db,
    sandbox,
    methods: run(fs.readFileSync(`${SERVER_ROOT}/server.js`, 'utf8'))
  };
}

// renderData is the only way a serverless method answers the front end, so
// tests have to capture it rather than read a return value.
function createRenderData() {
  let pending = null;

  function renderData(err, output) {
    if (pending === null) {
      throw new Error(`renderData called outside a call(): ${JSON.stringify(err || output)}`);
    }

    const settle = pending;

    pending = null;

    if (err) {
      settle.reject(err);
    } else {
      settle.resolve(output);
    }
  }

  // Wraps one serverless-method invocation and resolves with whatever that
  // method hands to renderData.
  renderData.call = (fn) => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    Promise.resolve(fn()).catch(reject);
  });

  return renderData;
}

module.exports = { loadServer, createRenderData, SERVER_ROOT };

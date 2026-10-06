'use strict';
// Node versions that resolve an explicit test directory as a module need an index.
// Keep the requested `node --test tests/` command working without a package dependency.
const fs = require('node:fs');
const path = require('node:path');
for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')).sort()) require(path.join(__dirname, file));

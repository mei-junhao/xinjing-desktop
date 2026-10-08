'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'fixture-047', 'package.json');
process.stdout.write(fs.readFileSync(p, 'utf8'));

// Generates build.json at the repo root (consumed by the /info endpoint).
// Replaces the former grunt 'buildjson' task. Runs both when imported (mocha
// loads it via .mocharc) and when invoked directly (node scripts/gen-build-info.js).

import fs from "fs";
import path from "path";

var pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"));

var output = {
    build_num : process.env.BUILD_NUMBER || 'local-build',
    git_hash : process.env.GIT_COMMIT_HASH || 'dev-hash',
    build_id : process.env.BUILD_ID || new Date().toISOString(),
    version : pkg.version
};

fs.writeFileSync(path.resolve(import.meta.dirname, '../build.json'), JSON.stringify(output));

export default output;

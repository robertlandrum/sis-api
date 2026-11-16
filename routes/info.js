import fs from "fs";
import path from "path";
import SIS from "../util/constants.js";

// all route controllers expose a setup method
export function setup(app, config) {
    var build = null;
    try {
        var buildPath = path.resolve(import.meta.dirname, '../build.json');
        build = fs.readFileSync(buildPath, 'utf8');
        build = JSON.parse(build);
    } catch (ex) {
        build = { 'err' : 'no info present' };
    }

    app.get("/api/:version/info", function(req, res) {
        res.status(200).json(build);
    });
}

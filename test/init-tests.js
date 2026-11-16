import * as util from "./fixtures/util.js";

describe('Initialize Tests', function() {
    var test = null;

    it("Should create the test", async function() {
        test = new util.LocalTest();
        await test.start();
    });

    it("Should stop the test", async function() {
        await test.stop();
    });
});

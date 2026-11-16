// simulate a schema update that occurs outside of the
// manager work flows
describe('Replication Simulation', function() {
  "use strict";

  var SIS = require("../util/constants");
  var should = require('should');
  var TestUtil = require('./fixtures/util');
  var ApiServer = new TestUtil.TestServer();

  var schemaManager = null;

  it("Should setup fixtures", async function() {
    schemaManager = (await ApiServer.start()).schemaManager;
    await ApiServer.becomeSuperUser();
  });

  after(async function() {
    await ApiServer.stop();
  });

  describe('schema update replicated', function() {
    var schema = {
        name : "repl_sim_schema",
        _sis : { owner : ["sistest"] },
        definition : {
            name : "String",
            number : "Number"
        }
    };

    var entity = {
        name : "repl_entity",
        number : 100
    };

    before(async function() {
        await schemaManager.objectRemoved(schema);
        schema = (await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201)).body;
        await ApiServer.post("/api/v1.1/entities/" + schema.name).send(entity).expect(201);
        // simulate a schema update
        schema._sis._updated_at += 1000;
        delete schema._id;
        schema.definition.bool = { type : "Boolean", default : true };
        await schemaManager.model.updateOne({ name : schema.name}, schema).exec();
    });
    it("should fetch the entity with the replicated definition", async function() {
        var res = await ApiServer.get("/api/v1.1/entities/" + schema.name)
            .expect(200);
        res.body.length.should.eql(1);
        // the default of the field the update added
        res.body[0].bool.should.eql(true);
    });
    it("should return a 404", async function() {
        // delete the model
        await schemaManager.model.deleteMany({ name : schema.name }).exec();
        // now expect a 404
        await ApiServer.get("/api/v1.1/entities/" + schema.name)
            .expect(404);
    });
    after(async function() {
        await schemaManager.objectRemoved(schema);
    });
  });
});

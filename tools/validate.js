"use strict";

// validates a schema - and an entity against it - without a database
var mongoose = require('mongoose');
var nconf = require('nconf');
var fs = require('fs');
var config = require('../config');
var createSchemaManager = require('../util/schema-manager');

if (process.argv.length < 3) {
    console.log("Require a schema JSON file with optional entity JSON file.");
    process.exit(1);
}

nconf.env('__').argv();
nconf.defaults(config);

var appConfig = nconf.get('app') || {};
var schemaManager = createSchemaManager(mongoose, appConfig);

// get the info for a user.
var schemaModel = null;
var schemaFile = process.argv[2];
try {
    var schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
    var validateErr = schemaManager.validate(schema);
    if (validateErr) {
        console.log("Schema is invalid.  " + validateErr);
        process.exit(1);
    }
    schemaModel = schemaManager.getEntityModel(schema);
} catch (ex) {
    console.log("Error validating schema. " + ex);
    process.exit(1);
}

// validate an entity against the schema
async function validateEntity(entityFile) {
    var entity;
    try {
        entity = JSON.parse(fs.readFileSync(entityFile, 'utf8'));
    } catch (ex) {
        console.log("Error reading the entity. " + ex);
        process.exit(1);
    }
    try {
        await new schemaModel(entity).validate();
    } catch (err) {
        console.log("Entity is invalid. " + err);
        process.exit(1);
    }
    console.log("Entity is valid.");
    process.exit(0);
}

if (process.argv.length >= 4) {
    validateEntity(process.argv[3]);
} else {
    console.log("Schema is valid.");
    process.exit(0);
}

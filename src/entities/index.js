import fs from 'fs';
import path from 'path';
import Sequelize from 'sequelize';
import DI from '../di';

//From https://github.com/angelxmoreno/sequelize-isunique-validator
Sequelize.prototype.validateIsUnique = (col, msg) => {
  const conditions = { where: {} };
  const message = msg || `${col} must be unique`;
  return function (value, next) {
    const self = this;
    this.Model.describe().then((schema) => {
      conditions.where[col] = value;
      Object
        .keys(schema)
        .filter(field => schema[field].primaryKey)
        .forEach((pk) => {
          conditions.where[pk] = { $ne: self[pk] };
        });
    }).then(() =>
      self.Model.count(conditions).then((found) =>
        (found !== 0) ? next(message) : next()
      )
    ).catch(next);
  };
};

const entities = {};
let sequelize = null;

export default class Entities {
  constructor(entitiesPath) {
    this.entitiesPath = entitiesPath;
  }

  init() {
    if (sequelize) {
      return;
    }
    const config = DI.get('config').get();
    const logger = DI.get('logger').getInstance();
    sequelize = new Sequelize(config.db.database, null, null,
      Object.assign({}, config.sequelize, config.db, { logging: logger.verbose }));
    
    fs
      .readdirSync(this.entitiesPath)
      .filter((file) => {
        const fileArray = file.split('.');
        return (file.indexOf('.') !== 0) &&
          (['js', 'es6'].indexOf(fileArray.pop()) !== -1) && (fileArray[0] !== 'index');
      })
      .forEach((file) => {
        const model = sequelize.import(path.join(this.entitiesPath, file));
        entities[model.name] = model;
      });

    Object.keys(entities).forEach((modelName) => {
      if ('associate' in entities[modelName]) {
        entities[modelName].associate(entities);
      }
    });
  }

  getSequelize() {
    return Sequelize;
  }

  /**
   * @returns {Sequelize}
   */
  getIntance() {
    this.init();
    return sequelize;
  }

  /**
   * @param name
   * @returns {Sequelize}
   */
  get(name) {
    this.init();
    return entities[name];
  }

  getAll() {
    this.init();
    return entities;
  }
};
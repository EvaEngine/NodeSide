import fs from 'fs';
import path from 'path';
import assert from 'assert';
import cloneDeep from 'lodash/cloneDeep';
import Sequelize from 'sequelize';
import util from 'util';
import DI from '../di';
import { getMicroTimestamp } from '../utils';
import { StandardException } from '../exceptions';

//From https://github.com/angelxmoreno/sequelize-isunique-validator
Sequelize.prototype.validateIsUnique = (col, msg) => {
  const conditions = { where: {} };
  const message = msg || `${col} must be unique`;
  return function v(value, next) {
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
      self.Model.count(conditions).then((found) => {
        if (found !== 0) {
          return next(message);
        }
        return next();
      })).catch(next);
  };
};


export default class Entities {
  /**
   * @param {string} entitiesPath
   * @param {Sequelize|Function} sequelizeInstance
   */
  constructor(entitiesPath, sequelizeInstance = null) {
    this.entitiesPath = entitiesPath;
    this.sequelize = sequelizeInstance;
    this.entities = {};
    this.scanned = false;
  }

  /**
   * Add tracer info to end of SQL query logging
   * @param options
   * @returns {*}
   */
  static addTracer(options = {}) {
    const logger = DI.get('logger');
    return Object.assign(options, {
      benchmark: true,
      logging: (...args) => {
        const tracer = DI.get('namespace').get('tracer');
        const [query, cost] = args;
        let pushed = false;
        if (tracer && cost > 0) {
          tracer.queries.push({
            query,
            cost: cost * 1000,
            finishedAt: getMicroTimestamp()
          });
          pushed = true;
        }
        logger.verbose(...args, !pushed ? '| Tracer' : '');
      }
    });
  }

  /**
   * Scan all entity schemas under a special path
   * @param entitiesPath
   * @param withAssociate
   * @returns {Entities}
   */
  scan(entitiesPath, withAssociate = true) {
    assert(this.sequelize && this.sequelize instanceof Sequelize, 'Scan entities require a sequelize instance');

    fs
      .readdirSync(entitiesPath)
      .filter((file) => {
        const fileArray = file.split('.');
        return (file.indexOf('.') !== 0) &&
          (['js', 'es6'].indexOf(fileArray.pop()) !== -1) && (fileArray[0] !== 'index');
      })
      .forEach((file) => {
        const entity = this.sequelize.import(path.join(entitiesPath, file));
        this.entities[entity.name] = entity;
      });

    if (!withAssociate) {
      return this;
    }

    Object.values(this.entities).forEach((entity) => {
      if ('associate' in entity) {
        entity.associate(this.entities);
      }
    });
    return this;
  }

  /**
   * Init sequelize instance from DI config
   * @param withAssociate
   * @returns {*}
   */
  init(withAssociate = true) {
    if (this.sequelize && this.scanned) {
      return this.sequelize;
    }

    const logger = DI.get('logger').getInstance();
    if (!this.sequelize) {
      const config = DI.get('config').get();
      const ns = DI.get('namespace');
      if (ns.isEnabled()) {
        //Inject sequelize inner namespace, refer: http://docs.sequelizejs.com/en/latest/docs/transactions/
        Sequelize.cls = ns.use().getContext();
      }

      const dbConfig = cloneDeep(config.db);
      if (process.env.SEQUELIZE_REPLICATION_CONFIG_KEY) {
        dbConfig.replication = dbConfig[process.env.SEQUELIZE_REPLICATION_CONFIG_KEY];
      }
      this.sequelize = new Sequelize(
        config.db.database, null, null,
        Object.assign({}, config.sequelize, dbConfig, Entities.addTracer())
      );
    } else {
      this.sequelize = util.isFunction(this.sequelize) ? this.sequelize() : this.sequelize;
    }

    this.scan(this.entitiesPath, withAssociate);
    this.scanned = true;

    //TODO: mask password in logging
    logger.debug('Entities init by scanned %s, Replication: %j', this.entitiesPath, this.sequelize.options.replication);
    return this;
  }

  /**
   * Shortcut for Sequelize query
   * @param sql
   * @param bind
   * @param options
   * @returns {*|{foo}|{}}
   */
  query(sql, bind = {}, options = {}) {
    return this.getInstance().query(sql, Object.assign({
      type: this.getSequelize().QueryTypes.SELECT
    }, options, { bind }));
  }

  /**
   * A shortcut to prevent repeat insert
   * @param tableName
   * @param input
   * @param uniqueCondition
   * @param transaction
   * @param options
   */
  uniqueInsert({
    tableName,
    input,
    uniqueCondition,
    transaction
  }, options = {}) {
    const inputObj = Object.assign({}, input);
    const typeAllowed = ['number', 'string', 'boolean'];
    Object.entries(inputObj).forEach((p) => {
      const valType = typeof p[1];
      //Allow null type here
      if (typeAllowed.indexOf(valType) === -1 && p[1] !== null) {
        throw new StandardException(`SQL inputObj ${p[0]}:${p[1]} with unsupported type ${valType}.`);
      } else if (valType === 'boolean') {
        if (p[1] === true) {
          inputObj[p[0]] = 1;
        } else {
          inputObj[p[0]] = 0;
        }
      }
    });
    const columns = Object.keys(inputObj);
    const columnString = ['`', columns.join('`, `'), '`'].join('');
    const valueString = Object.entries(inputObj).map(([key]) => `$${key} \`${key}\``).join(' , ');
    const uniqueString = typeof uniqueCondition === 'string' ? uniqueCondition :
      [`SELECT * FROM ${tableName} WHERE `, this.getInstance().dialect.QueryGenerator.getWhereConditions(uniqueCondition)].join('');
    /*
     Original Example:
     entities.getInstance().query(`INSERT INTO ${tableName}
     (userId, status)
     (
     SELECT *
     FROM (SELECT $userId userId, $status status) AS tmp
     WHERE NOT EXISTS (
     SELECT id FROM ${auditTable} WHERE userId = $userId AND status = 'pending'
     ) LIMIT 1
     )`, { bind, transaction, type: entities.getSequelize().QueryTypes.INSERT });
     */

    const sql = `INSERT INTO ${tableName} 
      (${columnString}) 
      (
        SELECT *
        FROM (SELECT ${valueString}) AS tmp
        WHERE NOT EXISTS (
          ${uniqueString} FOR UPDATE
        ) LIMIT 1
      )`; //add FOR UPDATE to use eXclusive Lock
    return this.getInstance().query(sql, Object.assign({
      bind: inputObj,
      transaction,
      type: Sequelize.QueryTypes.INSERT
    }, options));
  }

  /**
   * A short cut to start a database transaction
   * @param options
   */
  getTransaction(options = {}) {
    return this.getInstance().transaction(Object.assign({
      autocommit: true
    }, options));
  }

  /**
   * @returns {Sequelize}
   */
  getSequelize() {
    return Sequelize;
  }

  /**
   * @returns {Sequelize}
   */
  getInstance() {
    this.init();
    return this.sequelize;
  }

  /**
   * @param name
   * @returns {Sequelize}
   */
  get(name) {
    this.init();
    return this.entities[name];
  }

  /**
   * @returns {Object}
   */
  getAll() {
    this.init();
    return this.entities;
  }
}

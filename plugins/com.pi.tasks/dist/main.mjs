var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/rrule/dist/es5/rrule.js
var require_rrule = __commonJS({
  "node_modules/rrule/dist/es5/rrule.js"(exports, module) {
    (/* @__PURE__ */ __name(function webpackUniversalModuleDefinition(root, factory) {
      if (typeof exports === "object" && typeof module === "object")
        module.exports = factory();
      else if (typeof define === "function" && define.amd)
        define([], factory);
      else if (typeof exports === "object")
        exports["rrule"] = factory();
      else
        root["rrule"] = factory();
    }, "webpackUniversalModuleDefinition"))(typeof self !== "undefined" ? self : exports, () => {
      return (
        /******/
        (() => {
          "use strict";
          var __webpack_require__ = {};
          (() => {
            __webpack_require__.d = (exports2, definition) => {
              for (var key in definition) {
                if (__webpack_require__.o(definition, key) && !__webpack_require__.o(exports2, key)) {
                  Object.defineProperty(exports2, key, { enumerable: true, get: definition[key] });
                }
              }
            };
          })();
          (() => {
            __webpack_require__.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
          })();
          (() => {
            __webpack_require__.r = (exports2) => {
              if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
                Object.defineProperty(exports2, Symbol.toStringTag, { value: "Module" });
              }
              Object.defineProperty(exports2, "__esModule", { value: true });
            };
          })();
          var __webpack_exports__ = {};
          __webpack_require__.r(__webpack_exports__);
          __webpack_require__.d(__webpack_exports__, {
            "ALL_WEEKDAYS": /* @__PURE__ */ __name(() => (
              /* reexport */
              ALL_WEEKDAYS
            ), "ALL_WEEKDAYS"),
            "Frequency": /* @__PURE__ */ __name(() => (
              /* reexport */
              Frequency
            ), "Frequency"),
            "RRule": /* @__PURE__ */ __name(() => (
              /* reexport */
              RRule2
            ), "RRule"),
            "RRuleSet": /* @__PURE__ */ __name(() => (
              /* reexport */
              RRuleSet
            ), "RRuleSet"),
            "Weekday": /* @__PURE__ */ __name(() => (
              /* reexport */
              Weekday2
            ), "Weekday"),
            "datetime": /* @__PURE__ */ __name(() => (
              /* reexport */
              datetime
            ), "datetime"),
            "rrulestr": /* @__PURE__ */ __name(() => (
              /* reexport */
              rrulestr
            ), "rrulestr")
          });
          ;
          var ALL_WEEKDAYS = [
            "MO",
            "TU",
            "WE",
            "TH",
            "FR",
            "SA",
            "SU"
          ];
          var Weekday2 = (
            /** @class */
            function() {
              function Weekday3(weekday, n) {
                if (n === 0)
                  throw new Error("Can't create weekday with n == 0");
                this.weekday = weekday;
                this.n = n;
              }
              __name(Weekday3, "Weekday");
              Weekday3.fromStr = function(str) {
                return new Weekday3(ALL_WEEKDAYS.indexOf(str));
              };
              Weekday3.prototype.nth = function(n) {
                return this.n === n ? this : new Weekday3(this.weekday, n);
              };
              Weekday3.prototype.equals = function(other) {
                return this.weekday === other.weekday && this.n === other.n;
              };
              Weekday3.prototype.toString = function() {
                var s = ALL_WEEKDAYS[this.weekday];
                if (this.n)
                  s = (this.n > 0 ? "+" : "") + String(this.n) + s;
                return s;
              };
              Weekday3.prototype.getJsWeekday = function() {
                return this.weekday === 6 ? 0 : this.weekday + 1;
              };
              return Weekday3;
            }()
          );
          ;
          var isPresent = /* @__PURE__ */ __name(function(value) {
            return value !== null && value !== void 0;
          }, "isPresent");
          var isNumber = /* @__PURE__ */ __name(function(value) {
            return typeof value === "number";
          }, "isNumber");
          var isWeekdayStr = /* @__PURE__ */ __name(function(value) {
            return typeof value === "string" && ALL_WEEKDAYS.includes(value);
          }, "isWeekdayStr");
          var isArray = Array.isArray;
          var range = /* @__PURE__ */ __name(function(start, end) {
            if (end === void 0) {
              end = start;
            }
            if (arguments.length === 1) {
              end = start;
              start = 0;
            }
            var rang = [];
            for (var i = start; i < end; i++)
              rang.push(i);
            return rang;
          }, "range");
          var clone = /* @__PURE__ */ __name(function(array) {
            return [].concat(array);
          }, "clone");
          var repeat = /* @__PURE__ */ __name(function(value, times) {
            var i = 0;
            var array = [];
            if (isArray(value)) {
              for (; i < times; i++)
                array[i] = [].concat(value);
            } else {
              for (; i < times; i++)
                array[i] = value;
            }
            return array;
          }, "repeat");
          var toArray = /* @__PURE__ */ __name(function(item) {
            if (isArray(item)) {
              return item;
            }
            return [item];
          }, "toArray");
          function padStart(item, targetLength, padString) {
            if (padString === void 0) {
              padString = " ";
            }
            var str = String(item);
            targetLength = targetLength >> 0;
            if (str.length > targetLength) {
              return String(str);
            }
            targetLength = targetLength - str.length;
            if (targetLength > padString.length) {
              padString += repeat(padString, targetLength / padString.length);
            }
            return padString.slice(0, targetLength) + String(str);
          }
          __name(padStart, "padStart");
          var split = /* @__PURE__ */ __name(function(str, sep, num) {
            var splits = str.split(sep);
            return num ? splits.slice(0, num).concat([splits.slice(num).join(sep)]) : splits;
          }, "split");
          var pymod = /* @__PURE__ */ __name(function(a, b) {
            var r = a % b;
            return r * b < 0 ? r + b : r;
          }, "pymod");
          var divmod = /* @__PURE__ */ __name(function(a, b) {
            return { div: Math.floor(a / b), mod: pymod(a, b) };
          }, "divmod");
          var empty = /* @__PURE__ */ __name(function(obj) {
            return !isPresent(obj) || obj.length === 0;
          }, "empty");
          var notEmpty = /* @__PURE__ */ __name(function(obj) {
            return !empty(obj);
          }, "notEmpty");
          var includes = /* @__PURE__ */ __name(function(arr, val) {
            return notEmpty(arr) && arr.indexOf(val) !== -1;
          }, "includes");
          ;
          var datetime = /* @__PURE__ */ __name(function(y, m, d, h, i, s) {
            if (h === void 0) {
              h = 0;
            }
            if (i === void 0) {
              i = 0;
            }
            if (s === void 0) {
              s = 0;
            }
            return new Date(Date.UTC(y, m - 1, d, h, i, s));
          }, "datetime");
          var MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
          var ONE_DAY = 1e3 * 60 * 60 * 24;
          var MAXYEAR = 9999;
          var ORDINAL_BASE = datetime(1970, 1, 1);
          var PY_WEEKDAYS = [6, 0, 1, 2, 3, 4, 5];
          var getYearDay = /* @__PURE__ */ __name(function(date) {
            var dateNoTime = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
            return Math.ceil((dateNoTime.valueOf() - new Date(date.getUTCFullYear(), 0, 1).valueOf()) / ONE_DAY) + 1;
          }, "getYearDay");
          var isLeapYear = /* @__PURE__ */ __name(function(year) {
            return year % 4 === 0 && year % 100 !== 0 || year % 400 === 0;
          }, "isLeapYear");
          var isDate = /* @__PURE__ */ __name(function(value) {
            return value instanceof Date;
          }, "isDate");
          var isValidDate = /* @__PURE__ */ __name(function(value) {
            return isDate(value) && !isNaN(value.getTime());
          }, "isValidDate");
          var tzOffset = /* @__PURE__ */ __name(function(date) {
            return date.getTimezoneOffset() * 60 * 1e3;
          }, "tzOffset");
          var daysBetween2 = /* @__PURE__ */ __name(function(date1, date2) {
            var date1ms = date1.getTime();
            var date2ms = date2.getTime();
            var differencems = date1ms - date2ms;
            return Math.round(differencems / ONE_DAY);
          }, "daysBetween");
          var toOrdinal = /* @__PURE__ */ __name(function(date) {
            return daysBetween2(date, ORDINAL_BASE);
          }, "toOrdinal");
          var fromOrdinal = /* @__PURE__ */ __name(function(ordinal) {
            return new Date(ORDINAL_BASE.getTime() + ordinal * ONE_DAY);
          }, "fromOrdinal");
          var getMonthDays = /* @__PURE__ */ __name(function(date) {
            var month = date.getUTCMonth();
            return month === 1 && isLeapYear(date.getUTCFullYear()) ? 29 : MONTH_DAYS[month];
          }, "getMonthDays");
          var getWeekday = /* @__PURE__ */ __name(function(date) {
            return PY_WEEKDAYS[date.getUTCDay()];
          }, "getWeekday");
          var monthRange = /* @__PURE__ */ __name(function(year, month) {
            var date = datetime(year, month + 1, 1);
            return [getWeekday(date), getMonthDays(date)];
          }, "monthRange");
          var combine = /* @__PURE__ */ __name(function(date, time) {
            time = time || date;
            return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), time.getHours(), time.getMinutes(), time.getSeconds(), time.getMilliseconds()));
          }, "combine");
          var dateutil_clone = /* @__PURE__ */ __name(function(date) {
            var dolly = new Date(date.getTime());
            return dolly;
          }, "dateutil_clone");
          var cloneDates = /* @__PURE__ */ __name(function(dates) {
            var clones = [];
            for (var i = 0; i < dates.length; i++) {
              clones.push(dateutil_clone(dates[i]));
            }
            return clones;
          }, "cloneDates");
          var sort = /* @__PURE__ */ __name(function(dates) {
            dates.sort(function(a, b) {
              return a.getTime() - b.getTime();
            });
          }, "sort");
          var timeToUntilString = /* @__PURE__ */ __name(function(time, utc) {
            if (utc === void 0) {
              utc = true;
            }
            var date = new Date(time);
            return [
              padStart(date.getUTCFullYear().toString(), 4, "0"),
              padStart(date.getUTCMonth() + 1, 2, "0"),
              padStart(date.getUTCDate(), 2, "0"),
              "T",
              padStart(date.getUTCHours(), 2, "0"),
              padStart(date.getUTCMinutes(), 2, "0"),
              padStart(date.getUTCSeconds(), 2, "0"),
              utc ? "Z" : ""
            ].join("");
          }, "timeToUntilString");
          var untilStringToDate = /* @__PURE__ */ __name(function(until) {
            var re = /^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?$/;
            var bits = re.exec(until);
            if (!bits)
              throw new Error("Invalid UNTIL value: ".concat(until));
            return new Date(Date.UTC(parseInt(bits[1], 10), parseInt(bits[2], 10) - 1, parseInt(bits[3], 10), parseInt(bits[5], 10) || 0, parseInt(bits[6], 10) || 0, parseInt(bits[7], 10) || 0));
          }, "untilStringToDate");
          var dateTZtoISO8601 = /* @__PURE__ */ __name(function(date, timeZone) {
            var dateStr = date.toLocaleString("sv-SE", { timeZone });
            return dateStr.replace(" ", "T") + "Z";
          }, "dateTZtoISO8601");
          var dateInTimeZone = /* @__PURE__ */ __name(function(date, timeZone) {
            var localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            var dateInLocalTZ = new Date(dateTZtoISO8601(date, localTimeZone));
            var dateInTargetTZ = new Date(dateTZtoISO8601(date, timeZone !== null && timeZone !== void 0 ? timeZone : "UTC"));
            var tzOffset2 = dateInTargetTZ.getTime() - dateInLocalTZ.getTime();
            return new Date(date.getTime() - tzOffset2);
          }, "dateInTimeZone");
          ;
          var IterResult = (
            /** @class */
            function() {
              function IterResult2(method, args) {
                this.minDate = null;
                this.maxDate = null;
                this._result = [];
                this.total = 0;
                this.method = method;
                this.args = args;
                if (method === "between") {
                  this.maxDate = args.inc ? args.before : new Date(args.before.getTime() - 1);
                  this.minDate = args.inc ? args.after : new Date(args.after.getTime() + 1);
                } else if (method === "before") {
                  this.maxDate = args.inc ? args.dt : new Date(args.dt.getTime() - 1);
                } else if (method === "after") {
                  this.minDate = args.inc ? args.dt : new Date(args.dt.getTime() + 1);
                }
              }
              __name(IterResult2, "IterResult");
              IterResult2.prototype.accept = function(date) {
                ++this.total;
                var tooEarly = this.minDate && date < this.minDate;
                var tooLate = this.maxDate && date > this.maxDate;
                if (this.method === "between") {
                  if (tooEarly)
                    return true;
                  if (tooLate)
                    return false;
                } else if (this.method === "before") {
                  if (tooLate)
                    return false;
                } else if (this.method === "after") {
                  if (tooEarly)
                    return true;
                  this.add(date);
                  return false;
                }
                return this.add(date);
              };
              IterResult2.prototype.add = function(date) {
                this._result.push(date);
                return true;
              };
              IterResult2.prototype.getValue = function() {
                var res = this._result;
                switch (this.method) {
                  case "all":
                  case "between":
                    return res;
                  case "before":
                  case "after":
                  default:
                    return res.length ? res[res.length - 1] : null;
                }
              };
              IterResult2.prototype.clone = function() {
                return new IterResult2(this.method, this.args);
              };
              return IterResult2;
            }()
          );
          const iterresult = IterResult;
          ;
          var extendStatics = /* @__PURE__ */ __name(function(d, b) {
            extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
              d2.__proto__ = b2;
            } || function(d2, b2) {
              for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
            };
            return extendStatics(d, b);
          }, "extendStatics");
          function __extends(d, b) {
            if (typeof b !== "function" && b !== null)
              throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
            extendStatics(d, b);
            function __() {
              this.constructor = d;
            }
            __name(__, "__");
            d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
          }
          __name(__extends, "__extends");
          var __assign = /* @__PURE__ */ __name(function() {
            __assign = Object.assign || /* @__PURE__ */ __name(function __assign2(t) {
              for (var s, i = 1, n = arguments.length; i < n; i++) {
                s = arguments[i];
                for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
              }
              return t;
            }, "__assign");
            return __assign.apply(this, arguments);
          }, "__assign");
          function __rest(s, e) {
            var t = {};
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
              t[p] = s[p];
            if (s != null && typeof Object.getOwnPropertySymbols === "function")
              for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
                if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                  t[p[i]] = s[p[i]];
              }
            return t;
          }
          __name(__rest, "__rest");
          function __decorate(decorators, target, key, desc) {
            var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
            if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
            else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
            return c > 3 && r && Object.defineProperty(target, key, r), r;
          }
          __name(__decorate, "__decorate");
          function __param(paramIndex, decorator) {
            return function(target, key) {
              decorator(target, key, paramIndex);
            };
          }
          __name(__param, "__param");
          function __metadata(metadataKey, metadataValue) {
            if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
          }
          __name(__metadata, "__metadata");
          function __awaiter(thisArg, _arguments, P, generator) {
            function adopt(value) {
              return value instanceof P ? value : new P(function(resolve) {
                resolve(value);
              });
            }
            __name(adopt, "adopt");
            return new (P || (P = Promise))(function(resolve, reject) {
              function fulfilled(value) {
                try {
                  step(generator.next(value));
                } catch (e) {
                  reject(e);
                }
              }
              __name(fulfilled, "fulfilled");
              function rejected(value) {
                try {
                  step(generator["throw"](value));
                } catch (e) {
                  reject(e);
                }
              }
              __name(rejected, "rejected");
              function step(result) {
                result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
              }
              __name(step, "step");
              step((generator = generator.apply(thisArg, _arguments || [])).next());
            });
          }
          __name(__awaiter, "__awaiter");
          function __generator(thisArg, body) {
            var _ = { label: 0, sent: /* @__PURE__ */ __name(function() {
              if (t[0] & 1) throw t[1];
              return t[1];
            }, "sent"), trys: [], ops: [] }, f, y, t, g;
            return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
              return this;
            }), g;
            function verb(n) {
              return function(v) {
                return step([n, v]);
              };
            }
            __name(verb, "verb");
            function step(op) {
              if (f) throw new TypeError("Generator is already executing.");
              while (_) try {
                if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
                if (y = 0, t) op = [op[0] & 2, t.value];
                switch (op[0]) {
                  case 0:
                  case 1:
                    t = op;
                    break;
                  case 4:
                    _.label++;
                    return { value: op[1], done: false };
                  case 5:
                    _.label++;
                    y = op[1];
                    op = [0];
                    continue;
                  case 7:
                    op = _.ops.pop();
                    _.trys.pop();
                    continue;
                  default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
                      _ = 0;
                      continue;
                    }
                    if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
                      _.label = op[1];
                      break;
                    }
                    if (op[0] === 6 && _.label < t[1]) {
                      _.label = t[1];
                      t = op;
                      break;
                    }
                    if (t && _.label < t[2]) {
                      _.label = t[2];
                      _.ops.push(op);
                      break;
                    }
                    if (t[2]) _.ops.pop();
                    _.trys.pop();
                    continue;
                }
                op = body.call(thisArg, _);
              } catch (e) {
                op = [6, e];
                y = 0;
              } finally {
                f = t = 0;
              }
              if (op[0] & 5) throw op[1];
              return { value: op[0] ? op[1] : void 0, done: true };
            }
            __name(step, "step");
          }
          __name(__generator, "__generator");
          var __createBinding = Object.create ? function(o, m, k, k2) {
            if (k2 === void 0) k2 = k;
            var desc = Object.getOwnPropertyDescriptor(m, k);
            if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
              desc = { enumerable: true, get: /* @__PURE__ */ __name(function() {
                return m[k];
              }, "get") };
            }
            Object.defineProperty(o, k2, desc);
          } : function(o, m, k, k2) {
            if (k2 === void 0) k2 = k;
            o[k2] = m[k];
          };
          function __exportStar(m, o) {
            for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(o, p)) __createBinding(o, m, p);
          }
          __name(__exportStar, "__exportStar");
          function __values(o) {
            var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
            if (m) return m.call(o);
            if (o && typeof o.length === "number") return {
              next: /* @__PURE__ */ __name(function() {
                if (o && i >= o.length) o = void 0;
                return { value: o && o[i++], done: !o };
              }, "next")
            };
            throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
          }
          __name(__values, "__values");
          function __read(o, n) {
            var m = typeof Symbol === "function" && o[Symbol.iterator];
            if (!m) return o;
            var i = m.call(o), r, ar = [], e;
            try {
              while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
            } catch (error) {
              e = { error };
            } finally {
              try {
                if (r && !r.done && (m = i["return"])) m.call(i);
              } finally {
                if (e) throw e.error;
              }
            }
            return ar;
          }
          __name(__read, "__read");
          function __spread() {
            for (var ar = [], i = 0; i < arguments.length; i++)
              ar = ar.concat(__read(arguments[i]));
            return ar;
          }
          __name(__spread, "__spread");
          function __spreadArrays() {
            for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
            for (var r = Array(s), k = 0, i = 0; i < il; i++)
              for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
                r[k] = a[j];
            return r;
          }
          __name(__spreadArrays, "__spreadArrays");
          function __spreadArray(to, from, pack) {
            if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
              if (ar || !(i in from)) {
                if (!ar) ar = Array.prototype.slice.call(from, 0, i);
                ar[i] = from[i];
              }
            }
            return to.concat(ar || Array.prototype.slice.call(from));
          }
          __name(__spreadArray, "__spreadArray");
          function __await(v) {
            return this instanceof __await ? (this.v = v, this) : new __await(v);
          }
          __name(__await, "__await");
          function __asyncGenerator(thisArg, _arguments, generator) {
            if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
            var g = generator.apply(thisArg, _arguments || []), i, q = [];
            return i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
              return this;
            }, i;
            function verb(n) {
              if (g[n]) i[n] = function(v) {
                return new Promise(function(a, b) {
                  q.push([n, v, a, b]) > 1 || resume(n, v);
                });
              };
            }
            __name(verb, "verb");
            function resume(n, v) {
              try {
                step(g[n](v));
              } catch (e) {
                settle(q[0][3], e);
              }
            }
            __name(resume, "resume");
            function step(r) {
              r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
            }
            __name(step, "step");
            function fulfill(value) {
              resume("next", value);
            }
            __name(fulfill, "fulfill");
            function reject(value) {
              resume("throw", value);
            }
            __name(reject, "reject");
            function settle(f, v) {
              if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]);
            }
            __name(settle, "settle");
          }
          __name(__asyncGenerator, "__asyncGenerator");
          function __asyncDelegator(o) {
            var i, p;
            return i = {}, verb("next"), verb("throw", function(e) {
              throw e;
            }), verb("return"), i[Symbol.iterator] = function() {
              return this;
            }, i;
            function verb(n, f) {
              i[n] = o[n] ? function(v) {
                return (p = !p) ? { value: __await(o[n](v)), done: n === "return" } : f ? f(v) : v;
              } : f;
            }
            __name(verb, "verb");
          }
          __name(__asyncDelegator, "__asyncDelegator");
          function __asyncValues(o) {
            if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
            var m = o[Symbol.asyncIterator], i;
            return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
              return this;
            }, i);
            function verb(n) {
              i[n] = o[n] && function(v) {
                return new Promise(function(resolve, reject) {
                  v = o[n](v), settle(resolve, reject, v.done, v.value);
                });
              };
            }
            __name(verb, "verb");
            function settle(resolve, reject, d, v) {
              Promise.resolve(v).then(function(v2) {
                resolve({ value: v2, done: d });
              }, reject);
            }
            __name(settle, "settle");
          }
          __name(__asyncValues, "__asyncValues");
          function __makeTemplateObject(cooked, raw) {
            if (Object.defineProperty) {
              Object.defineProperty(cooked, "raw", { value: raw });
            } else {
              cooked.raw = raw;
            }
            return cooked;
          }
          __name(__makeTemplateObject, "__makeTemplateObject");
          ;
          var __setModuleDefault = Object.create ? function(o, v) {
            Object.defineProperty(o, "default", { enumerable: true, value: v });
          } : function(o, v) {
            o["default"] = v;
          };
          function __importStar(mod) {
            if (mod && mod.__esModule) return mod;
            var result = {};
            if (mod != null) {
              for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
            }
            __setModuleDefault(result, mod);
            return result;
          }
          __name(__importStar, "__importStar");
          function __importDefault(mod) {
            return mod && mod.__esModule ? mod : { default: mod };
          }
          __name(__importDefault, "__importDefault");
          function __classPrivateFieldGet(receiver, state2, kind, f) {
            if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
            if (typeof state2 === "function" ? receiver !== state2 || !f : !state2.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
            return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state2.get(receiver);
          }
          __name(__classPrivateFieldGet, "__classPrivateFieldGet");
          function __classPrivateFieldSet(receiver, state2, value, kind, f) {
            if (kind === "m") throw new TypeError("Private method is not writable");
            if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
            if (typeof state2 === "function" ? receiver !== state2 || !f : !state2.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
            return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state2.set(receiver, value), value;
          }
          __name(__classPrivateFieldSet, "__classPrivateFieldSet");
          function __classPrivateFieldIn(state2, receiver) {
            if (receiver === null || typeof receiver !== "object" && typeof receiver !== "function") throw new TypeError("Cannot use 'in' operator on non-object");
            return typeof state2 === "function" ? receiver === state2 : state2.has(receiver);
          }
          __name(__classPrivateFieldIn, "__classPrivateFieldIn");
          ;
          var CallbackIterResult = (
            /** @class */
            function(_super) {
              __extends(CallbackIterResult2, _super);
              function CallbackIterResult2(method, args, iterator) {
                var _this = _super.call(this, method, args) || this;
                _this.iterator = iterator;
                return _this;
              }
              __name(CallbackIterResult2, "CallbackIterResult");
              CallbackIterResult2.prototype.add = function(date) {
                if (this.iterator(date, this._result.length)) {
                  this._result.push(date);
                  return true;
                }
                return false;
              };
              return CallbackIterResult2;
            }(iterresult)
          );
          const callbackiterresult = CallbackIterResult;
          ;
          var ENGLISH = {
            dayNames: [
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday"
            ],
            monthNames: [
              "January",
              "February",
              "March",
              "April",
              "May",
              "June",
              "July",
              "August",
              "September",
              "October",
              "November",
              "December"
            ],
            tokens: {
              SKIP: /^[ \r\n\t]+|^\.$/,
              number: /^[1-9][0-9]*/,
              numberAsText: /^(one|two|three)/i,
              every: /^every/i,
              "day(s)": /^days?/i,
              "weekday(s)": /^weekdays?/i,
              "week(s)": /^weeks?/i,
              "hour(s)": /^hours?/i,
              "minute(s)": /^minutes?/i,
              "month(s)": /^months?/i,
              "year(s)": /^years?/i,
              on: /^(on|in)/i,
              at: /^(at)/i,
              the: /^the/i,
              first: /^first/i,
              second: /^second/i,
              third: /^third/i,
              nth: /^([1-9][0-9]*)(\.|th|nd|rd|st)/i,
              last: /^last/i,
              for: /^for/i,
              "time(s)": /^times?/i,
              until: /^(un)?til/i,
              monday: /^mo(n(day)?)?/i,
              tuesday: /^tu(e(s(day)?)?)?/i,
              wednesday: /^we(d(n(esday)?)?)?/i,
              thursday: /^th(u(r(sday)?)?)?/i,
              friday: /^fr(i(day)?)?/i,
              saturday: /^sa(t(urday)?)?/i,
              sunday: /^su(n(day)?)?/i,
              january: /^jan(uary)?/i,
              february: /^feb(ruary)?/i,
              march: /^mar(ch)?/i,
              april: /^apr(il)?/i,
              may: /^may/i,
              june: /^june?/i,
              july: /^july?/i,
              august: /^aug(ust)?/i,
              september: /^sep(t(ember)?)?/i,
              october: /^oct(ober)?/i,
              november: /^nov(ember)?/i,
              december: /^dec(ember)?/i,
              comma: /^(,\s*|(and|or)\s*)+/i
            }
          };
          const i18n = ENGLISH;
          ;
          var contains = /* @__PURE__ */ __name(function(arr, val) {
            return arr.indexOf(val) !== -1;
          }, "contains");
          var defaultGetText = /* @__PURE__ */ __name(function(id) {
            return id.toString();
          }, "defaultGetText");
          var defaultDateFormatter = /* @__PURE__ */ __name(function(year, month, day) {
            return "".concat(month, " ").concat(day, ", ").concat(year);
          }, "defaultDateFormatter");
          var ToText = (
            /** @class */
            function() {
              function ToText2(rrule, gettext, language, dateFormatter) {
                if (gettext === void 0) {
                  gettext = defaultGetText;
                }
                if (language === void 0) {
                  language = i18n;
                }
                if (dateFormatter === void 0) {
                  dateFormatter = defaultDateFormatter;
                }
                this.text = [];
                this.language = language || i18n;
                this.gettext = gettext;
                this.dateFormatter = dateFormatter;
                this.rrule = rrule;
                this.options = rrule.options;
                this.origOptions = rrule.origOptions;
                if (this.origOptions.bymonthday) {
                  var bymonthday = [].concat(this.options.bymonthday);
                  var bynmonthday = [].concat(this.options.bynmonthday);
                  bymonthday.sort(function(a, b) {
                    return a - b;
                  });
                  bynmonthday.sort(function(a, b) {
                    return b - a;
                  });
                  this.bymonthday = bymonthday.concat(bynmonthday);
                  if (!this.bymonthday.length)
                    this.bymonthday = null;
                }
                if (isPresent(this.origOptions.byweekday)) {
                  var byweekday = !isArray(this.origOptions.byweekday) ? [this.origOptions.byweekday] : this.origOptions.byweekday;
                  var days = String(byweekday);
                  this.byweekday = {
                    allWeeks: byweekday.filter(function(weekday) {
                      return !weekday.n;
                    }),
                    someWeeks: byweekday.filter(function(weekday) {
                      return Boolean(weekday.n);
                    }),
                    isWeekdays: days.indexOf("MO") !== -1 && days.indexOf("TU") !== -1 && days.indexOf("WE") !== -1 && days.indexOf("TH") !== -1 && days.indexOf("FR") !== -1 && days.indexOf("SA") === -1 && days.indexOf("SU") === -1,
                    isEveryDay: days.indexOf("MO") !== -1 && days.indexOf("TU") !== -1 && days.indexOf("WE") !== -1 && days.indexOf("TH") !== -1 && days.indexOf("FR") !== -1 && days.indexOf("SA") !== -1 && days.indexOf("SU") !== -1
                  };
                  var sortWeekDays = /* @__PURE__ */ __name(function(a, b) {
                    return a.weekday - b.weekday;
                  }, "sortWeekDays");
                  this.byweekday.allWeeks.sort(sortWeekDays);
                  this.byweekday.someWeeks.sort(sortWeekDays);
                  if (!this.byweekday.allWeeks.length)
                    this.byweekday.allWeeks = null;
                  if (!this.byweekday.someWeeks.length)
                    this.byweekday.someWeeks = null;
                } else {
                  this.byweekday = null;
                }
              }
              __name(ToText2, "ToText");
              ToText2.isFullyConvertible = function(rrule) {
                var canConvert = true;
                if (!(rrule.options.freq in ToText2.IMPLEMENTED))
                  return false;
                if (rrule.origOptions.until && rrule.origOptions.count)
                  return false;
                for (var key in rrule.origOptions) {
                  if (contains(["dtstart", "tzid", "wkst", "freq"], key))
                    return true;
                  if (!contains(ToText2.IMPLEMENTED[rrule.options.freq], key))
                    return false;
                }
                return canConvert;
              };
              ToText2.prototype.isFullyConvertible = function() {
                return ToText2.isFullyConvertible(this.rrule);
              };
              ToText2.prototype.toString = function() {
                var gettext = this.gettext;
                if (!(this.options.freq in ToText2.IMPLEMENTED)) {
                  return gettext("RRule error: Unable to fully convert this rrule to text");
                }
                this.text = [gettext("every")];
                this[RRule2.FREQUENCIES[this.options.freq]]();
                if (this.options.until) {
                  this.add(gettext("until"));
                  var until = this.options.until;
                  this.add(this.dateFormatter(until.getUTCFullYear(), this.language.monthNames[until.getUTCMonth()], until.getUTCDate()));
                } else if (this.options.count) {
                  this.add(gettext("for")).add(this.options.count.toString()).add(this.plural(this.options.count) ? gettext("times") : gettext("time"));
                }
                if (!this.isFullyConvertible())
                  this.add(gettext("(~ approximate)"));
                return this.text.join("");
              };
              ToText2.prototype.HOURLY = function() {
                var gettext = this.gettext;
                if (this.options.interval !== 1)
                  this.add(this.options.interval.toString());
                this.add(this.plural(this.options.interval) ? gettext("hours") : gettext("hour"));
              };
              ToText2.prototype.MINUTELY = function() {
                var gettext = this.gettext;
                if (this.options.interval !== 1)
                  this.add(this.options.interval.toString());
                this.add(this.plural(this.options.interval) ? gettext("minutes") : gettext("minute"));
              };
              ToText2.prototype.DAILY = function() {
                var gettext = this.gettext;
                if (this.options.interval !== 1)
                  this.add(this.options.interval.toString());
                if (this.byweekday && this.byweekday.isWeekdays) {
                  this.add(this.plural(this.options.interval) ? gettext("weekdays") : gettext("weekday"));
                } else {
                  this.add(this.plural(this.options.interval) ? gettext("days") : gettext("day"));
                }
                if (this.origOptions.bymonth) {
                  this.add(gettext("in"));
                  this._bymonth();
                }
                if (this.bymonthday) {
                  this._bymonthday();
                } else if (this.byweekday) {
                  this._byweekday();
                } else if (this.origOptions.byhour) {
                  this._byhour();
                }
              };
              ToText2.prototype.WEEKLY = function() {
                var gettext = this.gettext;
                if (this.options.interval !== 1) {
                  this.add(this.options.interval.toString()).add(this.plural(this.options.interval) ? gettext("weeks") : gettext("week"));
                }
                if (this.byweekday && this.byweekday.isWeekdays) {
                  if (this.options.interval === 1) {
                    this.add(this.plural(this.options.interval) ? gettext("weekdays") : gettext("weekday"));
                  } else {
                    this.add(gettext("on")).add(gettext("weekdays"));
                  }
                } else if (this.byweekday && this.byweekday.isEveryDay) {
                  this.add(this.plural(this.options.interval) ? gettext("days") : gettext("day"));
                } else {
                  if (this.options.interval === 1)
                    this.add(gettext("week"));
                  if (this.origOptions.bymonth) {
                    this.add(gettext("in"));
                    this._bymonth();
                  }
                  if (this.bymonthday) {
                    this._bymonthday();
                  } else if (this.byweekday) {
                    this._byweekday();
                  }
                  if (this.origOptions.byhour) {
                    this._byhour();
                  }
                }
              };
              ToText2.prototype.MONTHLY = function() {
                var gettext = this.gettext;
                if (this.origOptions.bymonth) {
                  if (this.options.interval !== 1) {
                    this.add(this.options.interval.toString()).add(gettext("months"));
                    if (this.plural(this.options.interval))
                      this.add(gettext("in"));
                  } else {
                  }
                  this._bymonth();
                } else {
                  if (this.options.interval !== 1) {
                    this.add(this.options.interval.toString());
                  }
                  this.add(this.plural(this.options.interval) ? gettext("months") : gettext("month"));
                }
                if (this.bymonthday) {
                  this._bymonthday();
                } else if (this.byweekday && this.byweekday.isWeekdays) {
                  this.add(gettext("on")).add(gettext("weekdays"));
                } else if (this.byweekday) {
                  this._byweekday();
                }
              };
              ToText2.prototype.YEARLY = function() {
                var gettext = this.gettext;
                if (this.origOptions.bymonth) {
                  if (this.options.interval !== 1) {
                    this.add(this.options.interval.toString());
                    this.add(gettext("years"));
                  } else {
                  }
                  this._bymonth();
                } else {
                  if (this.options.interval !== 1) {
                    this.add(this.options.interval.toString());
                  }
                  this.add(this.plural(this.options.interval) ? gettext("years") : gettext("year"));
                }
                if (this.bymonthday) {
                  this._bymonthday();
                } else if (this.byweekday) {
                  this._byweekday();
                }
                if (this.options.byyearday) {
                  this.add(gettext("on the")).add(this.list(this.options.byyearday, this.nth, gettext("and"))).add(gettext("day"));
                }
                if (this.options.byweekno) {
                  this.add(gettext("in")).add(this.plural(this.options.byweekno.length) ? gettext("weeks") : gettext("week")).add(this.list(this.options.byweekno, void 0, gettext("and")));
                }
              };
              ToText2.prototype._bymonthday = function() {
                var gettext = this.gettext;
                if (this.byweekday && this.byweekday.allWeeks) {
                  this.add(gettext("on")).add(this.list(this.byweekday.allWeeks, this.weekdaytext, gettext("or"))).add(gettext("the")).add(this.list(this.bymonthday, this.nth, gettext("or")));
                } else {
                  this.add(gettext("on the")).add(this.list(this.bymonthday, this.nth, gettext("and")));
                }
              };
              ToText2.prototype._byweekday = function() {
                var gettext = this.gettext;
                if (this.byweekday.allWeeks && !this.byweekday.isWeekdays) {
                  this.add(gettext("on")).add(this.list(this.byweekday.allWeeks, this.weekdaytext));
                }
                if (this.byweekday.someWeeks) {
                  if (this.byweekday.allWeeks)
                    this.add(gettext("and"));
                  this.add(gettext("on the")).add(this.list(this.byweekday.someWeeks, this.weekdaytext, gettext("and")));
                }
              };
              ToText2.prototype._byhour = function() {
                var gettext = this.gettext;
                this.add(gettext("at")).add(this.list(this.origOptions.byhour, void 0, gettext("and")));
              };
              ToText2.prototype._bymonth = function() {
                this.add(this.list(this.options.bymonth, this.monthtext, this.gettext("and")));
              };
              ToText2.prototype.nth = function(n) {
                n = parseInt(n.toString(), 10);
                var nth;
                var gettext = this.gettext;
                if (n === -1)
                  return gettext("last");
                var npos = Math.abs(n);
                switch (npos) {
                  case 1:
                  case 21:
                  case 31:
                    nth = npos + gettext("st");
                    break;
                  case 2:
                  case 22:
                    nth = npos + gettext("nd");
                    break;
                  case 3:
                  case 23:
                    nth = npos + gettext("rd");
                    break;
                  default:
                    nth = npos + gettext("th");
                }
                return n < 0 ? nth + " " + gettext("last") : nth;
              };
              ToText2.prototype.monthtext = function(m) {
                return this.language.monthNames[m - 1];
              };
              ToText2.prototype.weekdaytext = function(wday) {
                var weekday = isNumber(wday) ? (wday + 1) % 7 : wday.getJsWeekday();
                return (wday.n ? this.nth(wday.n) + " " : "") + this.language.dayNames[weekday];
              };
              ToText2.prototype.plural = function(n) {
                return n % 100 !== 1;
              };
              ToText2.prototype.add = function(s) {
                this.text.push(" ");
                this.text.push(s);
                return this;
              };
              ToText2.prototype.list = function(arr, callback, finalDelim, delim) {
                var _this = this;
                if (delim === void 0) {
                  delim = ",";
                }
                if (!isArray(arr)) {
                  arr = [arr];
                }
                var delimJoin = /* @__PURE__ */ __name(function(array, delimiter, finalDelimiter) {
                  var list = "";
                  for (var i = 0; i < array.length; i++) {
                    if (i !== 0) {
                      if (i === array.length - 1) {
                        list += " " + finalDelimiter + " ";
                      } else {
                        list += delimiter + " ";
                      }
                    }
                    list += array[i];
                  }
                  return list;
                }, "delimJoin");
                callback = callback || function(o) {
                  return o.toString();
                };
                var realCallback = /* @__PURE__ */ __name(function(arg) {
                  return callback && callback.call(_this, arg);
                }, "realCallback");
                if (finalDelim) {
                  return delimJoin(arr.map(realCallback), delim, finalDelim);
                } else {
                  return arr.map(realCallback).join(delim + " ");
                }
              };
              return ToText2;
            }()
          );
          const totext = ToText;
          ;
          var Parser = (
            /** @class */
            function() {
              function Parser2(rules) {
                this.done = true;
                this.rules = rules;
              }
              __name(Parser2, "Parser");
              Parser2.prototype.start = function(text2) {
                this.text = text2;
                this.done = false;
                return this.nextSymbol();
              };
              Parser2.prototype.isDone = function() {
                return this.done && this.symbol === null;
              };
              Parser2.prototype.nextSymbol = function() {
                var best;
                var bestSymbol;
                this.symbol = null;
                this.value = null;
                do {
                  if (this.done)
                    return false;
                  var rule = void 0;
                  best = null;
                  for (var name_1 in this.rules) {
                    rule = this.rules[name_1];
                    var match = rule.exec(this.text);
                    if (match) {
                      if (best === null || match[0].length > best[0].length) {
                        best = match;
                        bestSymbol = name_1;
                      }
                    }
                  }
                  if (best != null) {
                    this.text = this.text.substr(best[0].length);
                    if (this.text === "")
                      this.done = true;
                  }
                  if (best == null) {
                    this.done = true;
                    this.symbol = null;
                    this.value = null;
                    return;
                  }
                } while (bestSymbol === "SKIP");
                this.symbol = bestSymbol;
                this.value = best;
                return true;
              };
              Parser2.prototype.accept = function(name) {
                if (this.symbol === name) {
                  if (this.value) {
                    var v = this.value;
                    this.nextSymbol();
                    return v;
                  }
                  this.nextSymbol();
                  return true;
                }
                return false;
              };
              Parser2.prototype.acceptNumber = function() {
                return this.accept("number");
              };
              Parser2.prototype.expect = function(name) {
                if (this.accept(name))
                  return true;
                throw new Error("expected " + name + " but found " + this.symbol);
              };
              return Parser2;
            }()
          );
          function parseText(text2, language) {
            if (language === void 0) {
              language = i18n;
            }
            var options = {};
            var ttr = new Parser(language.tokens);
            if (!ttr.start(text2))
              return null;
            S();
            return options;
            function S() {
              ttr.expect("every");
              var n = ttr.acceptNumber();
              if (n)
                options.interval = parseInt(n[0], 10);
              if (ttr.isDone())
                throw new Error("Unexpected end");
              switch (ttr.symbol) {
                case "day(s)":
                  options.freq = RRule2.DAILY;
                  if (ttr.nextSymbol()) {
                    AT();
                    F();
                  }
                  break;
                // FIXME Note: every 2 weekdays != every two weeks on weekdays.
                // DAILY on weekdays is not a valid rule
                case "weekday(s)":
                  options.freq = RRule2.WEEKLY;
                  options.byweekday = [RRule2.MO, RRule2.TU, RRule2.WE, RRule2.TH, RRule2.FR];
                  ttr.nextSymbol();
                  AT();
                  F();
                  break;
                case "week(s)":
                  options.freq = RRule2.WEEKLY;
                  if (ttr.nextSymbol()) {
                    ON();
                    AT();
                    F();
                  }
                  break;
                case "hour(s)":
                  options.freq = RRule2.HOURLY;
                  if (ttr.nextSymbol()) {
                    ON();
                    F();
                  }
                  break;
                case "minute(s)":
                  options.freq = RRule2.MINUTELY;
                  if (ttr.nextSymbol()) {
                    ON();
                    F();
                  }
                  break;
                case "month(s)":
                  options.freq = RRule2.MONTHLY;
                  if (ttr.nextSymbol()) {
                    ON();
                    F();
                  }
                  break;
                case "year(s)":
                  options.freq = RRule2.YEARLY;
                  if (ttr.nextSymbol()) {
                    ON();
                    F();
                  }
                  break;
                case "monday":
                case "tuesday":
                case "wednesday":
                case "thursday":
                case "friday":
                case "saturday":
                case "sunday":
                  options.freq = RRule2.WEEKLY;
                  var key = ttr.symbol.substr(0, 2).toUpperCase();
                  options.byweekday = [RRule2[key]];
                  if (!ttr.nextSymbol())
                    return;
                  while (ttr.accept("comma")) {
                    if (ttr.isDone())
                      throw new Error("Unexpected end");
                    var wkd = decodeWKD();
                    if (!wkd) {
                      throw new Error("Unexpected symbol " + ttr.symbol + ", expected weekday");
                    }
                    options.byweekday.push(RRule2[wkd]);
                    ttr.nextSymbol();
                  }
                  AT();
                  MDAYs();
                  F();
                  break;
                case "january":
                case "february":
                case "march":
                case "april":
                case "may":
                case "june":
                case "july":
                case "august":
                case "september":
                case "october":
                case "november":
                case "december":
                  options.freq = RRule2.YEARLY;
                  options.bymonth = [decodeM()];
                  if (!ttr.nextSymbol())
                    return;
                  while (ttr.accept("comma")) {
                    if (ttr.isDone())
                      throw new Error("Unexpected end");
                    var m = decodeM();
                    if (!m) {
                      throw new Error("Unexpected symbol " + ttr.symbol + ", expected month");
                    }
                    options.bymonth.push(m);
                    ttr.nextSymbol();
                  }
                  ON();
                  F();
                  break;
                default:
                  throw new Error("Unknown symbol");
              }
            }
            __name(S, "S");
            function ON() {
              var on = ttr.accept("on");
              var the = ttr.accept("the");
              if (!(on || the))
                return;
              do {
                var nth = decodeNTH();
                var wkd = decodeWKD();
                var m = decodeM();
                if (nth) {
                  if (wkd) {
                    ttr.nextSymbol();
                    if (!options.byweekday)
                      options.byweekday = [];
                    options.byweekday.push(RRule2[wkd].nth(nth));
                  } else {
                    if (!options.bymonthday)
                      options.bymonthday = [];
                    options.bymonthday.push(nth);
                    ttr.accept("day(s)");
                  }
                } else if (wkd) {
                  ttr.nextSymbol();
                  if (!options.byweekday)
                    options.byweekday = [];
                  options.byweekday.push(RRule2[wkd]);
                } else if (ttr.symbol === "weekday(s)") {
                  ttr.nextSymbol();
                  if (!options.byweekday) {
                    options.byweekday = [RRule2.MO, RRule2.TU, RRule2.WE, RRule2.TH, RRule2.FR];
                  }
                } else if (ttr.symbol === "week(s)") {
                  ttr.nextSymbol();
                  var n = ttr.acceptNumber();
                  if (!n) {
                    throw new Error("Unexpected symbol " + ttr.symbol + ", expected week number");
                  }
                  options.byweekno = [parseInt(n[0], 10)];
                  while (ttr.accept("comma")) {
                    n = ttr.acceptNumber();
                    if (!n) {
                      throw new Error("Unexpected symbol " + ttr.symbol + "; expected monthday");
                    }
                    options.byweekno.push(parseInt(n[0], 10));
                  }
                } else if (m) {
                  ttr.nextSymbol();
                  if (!options.bymonth)
                    options.bymonth = [];
                  options.bymonth.push(m);
                } else {
                  return;
                }
              } while (ttr.accept("comma") || ttr.accept("the") || ttr.accept("on"));
            }
            __name(ON, "ON");
            function AT() {
              var at = ttr.accept("at");
              if (!at)
                return;
              do {
                var n = ttr.acceptNumber();
                if (!n) {
                  throw new Error("Unexpected symbol " + ttr.symbol + ", expected hour");
                }
                options.byhour = [parseInt(n[0], 10)];
                while (ttr.accept("comma")) {
                  n = ttr.acceptNumber();
                  if (!n) {
                    throw new Error("Unexpected symbol " + ttr.symbol + "; expected hour");
                  }
                  options.byhour.push(parseInt(n[0], 10));
                }
              } while (ttr.accept("comma") || ttr.accept("at"));
            }
            __name(AT, "AT");
            function decodeM() {
              switch (ttr.symbol) {
                case "january":
                  return 1;
                case "february":
                  return 2;
                case "march":
                  return 3;
                case "april":
                  return 4;
                case "may":
                  return 5;
                case "june":
                  return 6;
                case "july":
                  return 7;
                case "august":
                  return 8;
                case "september":
                  return 9;
                case "october":
                  return 10;
                case "november":
                  return 11;
                case "december":
                  return 12;
                default:
                  return false;
              }
            }
            __name(decodeM, "decodeM");
            function decodeWKD() {
              switch (ttr.symbol) {
                case "monday":
                case "tuesday":
                case "wednesday":
                case "thursday":
                case "friday":
                case "saturday":
                case "sunday":
                  return ttr.symbol.substr(0, 2).toUpperCase();
                default:
                  return false;
              }
            }
            __name(decodeWKD, "decodeWKD");
            function decodeNTH() {
              switch (ttr.symbol) {
                case "last":
                  ttr.nextSymbol();
                  return -1;
                case "first":
                  ttr.nextSymbol();
                  return 1;
                case "second":
                  ttr.nextSymbol();
                  return ttr.accept("last") ? -2 : 2;
                case "third":
                  ttr.nextSymbol();
                  return ttr.accept("last") ? -3 : 3;
                case "nth":
                  var v = parseInt(ttr.value[1], 10);
                  if (v < -366 || v > 366)
                    throw new Error("Nth out of range: " + v);
                  ttr.nextSymbol();
                  return ttr.accept("last") ? -v : v;
                default:
                  return false;
              }
            }
            __name(decodeNTH, "decodeNTH");
            function MDAYs() {
              ttr.accept("on");
              ttr.accept("the");
              var nth = decodeNTH();
              if (!nth)
                return;
              options.bymonthday = [nth];
              ttr.nextSymbol();
              while (ttr.accept("comma")) {
                nth = decodeNTH();
                if (!nth) {
                  throw new Error("Unexpected symbol " + ttr.symbol + "; expected monthday");
                }
                options.bymonthday.push(nth);
                ttr.nextSymbol();
              }
            }
            __name(MDAYs, "MDAYs");
            function F() {
              if (ttr.symbol === "until") {
                var date = Date.parse(ttr.text);
                if (!date)
                  throw new Error("Cannot parse until date:" + ttr.text);
                options.until = new Date(date);
              } else if (ttr.accept("for")) {
                options.count = parseInt(ttr.value[0], 10);
                ttr.expect("number");
              }
            }
            __name(F, "F");
          }
          __name(parseText, "parseText");
          ;
          var Frequency;
          (function(Frequency2) {
            Frequency2[Frequency2["YEARLY"] = 0] = "YEARLY";
            Frequency2[Frequency2["MONTHLY"] = 1] = "MONTHLY";
            Frequency2[Frequency2["WEEKLY"] = 2] = "WEEKLY";
            Frequency2[Frequency2["DAILY"] = 3] = "DAILY";
            Frequency2[Frequency2["HOURLY"] = 4] = "HOURLY";
            Frequency2[Frequency2["MINUTELY"] = 5] = "MINUTELY";
            Frequency2[Frequency2["SECONDLY"] = 6] = "SECONDLY";
          })(Frequency || (Frequency = {}));
          function freqIsDailyOrGreater(freq) {
            return freq < Frequency.HOURLY;
          }
          __name(freqIsDailyOrGreater, "freqIsDailyOrGreater");
          ;
          var fromText = /* @__PURE__ */ __name(function(text2, language) {
            if (language === void 0) {
              language = i18n;
            }
            return new RRule2(parseText(text2, language) || void 0);
          }, "fromText");
          var common = [
            "count",
            "until",
            "interval",
            "byweekday",
            "bymonthday",
            "bymonth"
          ];
          totext.IMPLEMENTED = [];
          totext.IMPLEMENTED[Frequency.HOURLY] = common;
          totext.IMPLEMENTED[Frequency.MINUTELY] = common;
          totext.IMPLEMENTED[Frequency.DAILY] = ["byhour"].concat(common);
          totext.IMPLEMENTED[Frequency.WEEKLY] = common;
          totext.IMPLEMENTED[Frequency.MONTHLY] = common;
          totext.IMPLEMENTED[Frequency.YEARLY] = ["byweekno", "byyearday"].concat(common);
          var toText = /* @__PURE__ */ __name(function(rrule, gettext, language, dateFormatter) {
            return new totext(rrule, gettext, language, dateFormatter).toString();
          }, "toText");
          var isFullyConvertible = totext.isFullyConvertible;
          ;
          var Time = (
            /** @class */
            function() {
              function Time2(hour, minute, second, millisecond) {
                this.hour = hour;
                this.minute = minute;
                this.second = second;
                this.millisecond = millisecond || 0;
              }
              __name(Time2, "Time");
              Time2.prototype.getHours = function() {
                return this.hour;
              };
              Time2.prototype.getMinutes = function() {
                return this.minute;
              };
              Time2.prototype.getSeconds = function() {
                return this.second;
              };
              Time2.prototype.getMilliseconds = function() {
                return this.millisecond;
              };
              Time2.prototype.getTime = function() {
                return (this.hour * 60 * 60 + this.minute * 60 + this.second) * 1e3 + this.millisecond;
              };
              return Time2;
            }()
          );
          var DateTime = (
            /** @class */
            function(_super) {
              __extends(DateTime2, _super);
              function DateTime2(year, month, day, hour, minute, second, millisecond) {
                var _this = _super.call(this, hour, minute, second, millisecond) || this;
                _this.year = year;
                _this.month = month;
                _this.day = day;
                return _this;
              }
              __name(DateTime2, "DateTime");
              DateTime2.fromDate = function(date) {
                return new this(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.valueOf() % 1e3);
              };
              DateTime2.prototype.getWeekday = function() {
                return getWeekday(new Date(this.getTime()));
              };
              DateTime2.prototype.getTime = function() {
                return new Date(Date.UTC(this.year, this.month - 1, this.day, this.hour, this.minute, this.second, this.millisecond)).getTime();
              };
              DateTime2.prototype.getDay = function() {
                return this.day;
              };
              DateTime2.prototype.getMonth = function() {
                return this.month;
              };
              DateTime2.prototype.getYear = function() {
                return this.year;
              };
              DateTime2.prototype.addYears = function(years) {
                this.year += years;
              };
              DateTime2.prototype.addMonths = function(months) {
                this.month += months;
                if (this.month > 12) {
                  var yearDiv = Math.floor(this.month / 12);
                  var monthMod = pymod(this.month, 12);
                  this.month = monthMod;
                  this.year += yearDiv;
                  if (this.month === 0) {
                    this.month = 12;
                    --this.year;
                  }
                }
              };
              DateTime2.prototype.addWeekly = function(days, wkst) {
                if (wkst > this.getWeekday()) {
                  this.day += -(this.getWeekday() + 1 + (6 - wkst)) + days * 7;
                } else {
                  this.day += -(this.getWeekday() - wkst) + days * 7;
                }
                this.fixDay();
              };
              DateTime2.prototype.addDaily = function(days) {
                this.day += days;
                this.fixDay();
              };
              DateTime2.prototype.addHours = function(hours, filtered, byhour) {
                if (filtered) {
                  this.hour += Math.floor((23 - this.hour) / hours) * hours;
                }
                for (; ; ) {
                  this.hour += hours;
                  var _a = divmod(this.hour, 24), dayDiv = _a.div, hourMod = _a.mod;
                  if (dayDiv) {
                    this.hour = hourMod;
                    this.addDaily(dayDiv);
                  }
                  if (empty(byhour) || includes(byhour, this.hour))
                    break;
                }
              };
              DateTime2.prototype.addMinutes = function(minutes, filtered, byhour, byminute) {
                if (filtered) {
                  this.minute += Math.floor((1439 - (this.hour * 60 + this.minute)) / minutes) * minutes;
                }
                for (; ; ) {
                  this.minute += minutes;
                  var _a = divmod(this.minute, 60), hourDiv = _a.div, minuteMod = _a.mod;
                  if (hourDiv) {
                    this.minute = minuteMod;
                    this.addHours(hourDiv, false, byhour);
                  }
                  if ((empty(byhour) || includes(byhour, this.hour)) && (empty(byminute) || includes(byminute, this.minute))) {
                    break;
                  }
                }
              };
              DateTime2.prototype.addSeconds = function(seconds, filtered, byhour, byminute, bysecond) {
                if (filtered) {
                  this.second += Math.floor((86399 - (this.hour * 3600 + this.minute * 60 + this.second)) / seconds) * seconds;
                }
                for (; ; ) {
                  this.second += seconds;
                  var _a = divmod(this.second, 60), minuteDiv = _a.div, secondMod = _a.mod;
                  if (minuteDiv) {
                    this.second = secondMod;
                    this.addMinutes(minuteDiv, false, byhour, byminute);
                  }
                  if ((empty(byhour) || includes(byhour, this.hour)) && (empty(byminute) || includes(byminute, this.minute)) && (empty(bysecond) || includes(bysecond, this.second))) {
                    break;
                  }
                }
              };
              DateTime2.prototype.fixDay = function() {
                if (this.day <= 28) {
                  return;
                }
                var daysinmonth = monthRange(this.year, this.month - 1)[1];
                if (this.day <= daysinmonth) {
                  return;
                }
                while (this.day > daysinmonth) {
                  this.day -= daysinmonth;
                  ++this.month;
                  if (this.month === 13) {
                    this.month = 1;
                    ++this.year;
                    if (this.year > MAXYEAR) {
                      return;
                    }
                  }
                  daysinmonth = monthRange(this.year, this.month - 1)[1];
                }
              };
              DateTime2.prototype.add = function(options, filtered) {
                var freq = options.freq, interval = options.interval, wkst = options.wkst, byhour = options.byhour, byminute = options.byminute, bysecond = options.bysecond;
                switch (freq) {
                  case Frequency.YEARLY:
                    return this.addYears(interval);
                  case Frequency.MONTHLY:
                    return this.addMonths(interval);
                  case Frequency.WEEKLY:
                    return this.addWeekly(interval, wkst);
                  case Frequency.DAILY:
                    return this.addDaily(interval);
                  case Frequency.HOURLY:
                    return this.addHours(interval, filtered, byhour);
                  case Frequency.MINUTELY:
                    return this.addMinutes(interval, filtered, byhour, byminute);
                  case Frequency.SECONDLY:
                    return this.addSeconds(interval, filtered, byhour, byminute, bysecond);
                }
              };
              return DateTime2;
            }(Time)
          );
          ;
          function initializeOptions(options) {
            var invalid = [];
            var keys = Object.keys(options);
            for (var _i = 0, keys_1 = keys; _i < keys_1.length; _i++) {
              var key = keys_1[_i];
              if (!includes(defaultKeys, key))
                invalid.push(key);
              if (isDate(options[key]) && !isValidDate(options[key])) {
                invalid.push(key);
              }
            }
            if (invalid.length) {
              throw new Error("Invalid options: " + invalid.join(", "));
            }
            return __assign({}, options);
          }
          __name(initializeOptions, "initializeOptions");
          function parseOptions(options) {
            var opts = __assign(__assign({}, DEFAULT_OPTIONS), initializeOptions(options));
            if (isPresent(opts.byeaster))
              opts.freq = RRule2.YEARLY;
            if (!(isPresent(opts.freq) && RRule2.FREQUENCIES[opts.freq])) {
              throw new Error("Invalid frequency: ".concat(opts.freq, " ").concat(options.freq));
            }
            if (!opts.dtstart)
              opts.dtstart = new Date((/* @__PURE__ */ new Date()).setMilliseconds(0));
            if (!isPresent(opts.wkst)) {
              opts.wkst = RRule2.MO.weekday;
            } else if (isNumber(opts.wkst)) {
            } else {
              opts.wkst = opts.wkst.weekday;
            }
            if (isPresent(opts.bysetpos)) {
              if (isNumber(opts.bysetpos))
                opts.bysetpos = [opts.bysetpos];
              for (var i = 0; i < opts.bysetpos.length; i++) {
                var v = opts.bysetpos[i];
                if (v === 0 || !(v >= -366 && v <= 366)) {
                  throw new Error("bysetpos must be between 1 and 366, or between -366 and -1");
                }
              }
            }
            if (!(Boolean(opts.byweekno) || notEmpty(opts.byweekno) || notEmpty(opts.byyearday) || Boolean(opts.bymonthday) || notEmpty(opts.bymonthday) || isPresent(opts.byweekday) || isPresent(opts.byeaster))) {
              switch (opts.freq) {
                case RRule2.YEARLY:
                  if (!opts.bymonth)
                    opts.bymonth = opts.dtstart.getUTCMonth() + 1;
                  opts.bymonthday = opts.dtstart.getUTCDate();
                  break;
                case RRule2.MONTHLY:
                  opts.bymonthday = opts.dtstart.getUTCDate();
                  break;
                case RRule2.WEEKLY:
                  opts.byweekday = [getWeekday(opts.dtstart)];
                  break;
              }
            }
            if (isPresent(opts.bymonth) && !isArray(opts.bymonth)) {
              opts.bymonth = [opts.bymonth];
            }
            if (isPresent(opts.byyearday) && !isArray(opts.byyearday) && isNumber(opts.byyearday)) {
              opts.byyearday = [opts.byyearday];
            }
            if (!isPresent(opts.bymonthday)) {
              opts.bymonthday = [];
              opts.bynmonthday = [];
            } else if (isArray(opts.bymonthday)) {
              var bymonthday = [];
              var bynmonthday = [];
              for (var i = 0; i < opts.bymonthday.length; i++) {
                var v = opts.bymonthday[i];
                if (v > 0) {
                  bymonthday.push(v);
                } else if (v < 0) {
                  bynmonthday.push(v);
                }
              }
              opts.bymonthday = bymonthday;
              opts.bynmonthday = bynmonthday;
            } else if (opts.bymonthday < 0) {
              opts.bynmonthday = [opts.bymonthday];
              opts.bymonthday = [];
            } else {
              opts.bynmonthday = [];
              opts.bymonthday = [opts.bymonthday];
            }
            if (isPresent(opts.byweekno) && !isArray(opts.byweekno)) {
              opts.byweekno = [opts.byweekno];
            }
            if (!isPresent(opts.byweekday)) {
              opts.bynweekday = null;
            } else if (isNumber(opts.byweekday)) {
              opts.byweekday = [opts.byweekday];
              opts.bynweekday = null;
            } else if (isWeekdayStr(opts.byweekday)) {
              opts.byweekday = [Weekday2.fromStr(opts.byweekday).weekday];
              opts.bynweekday = null;
            } else if (opts.byweekday instanceof Weekday2) {
              if (!opts.byweekday.n || opts.freq > RRule2.MONTHLY) {
                opts.byweekday = [opts.byweekday.weekday];
                opts.bynweekday = null;
              } else {
                opts.bynweekday = [[opts.byweekday.weekday, opts.byweekday.n]];
                opts.byweekday = null;
              }
            } else {
              var byweekday = [];
              var bynweekday = [];
              for (var i = 0; i < opts.byweekday.length; i++) {
                var wday = opts.byweekday[i];
                if (isNumber(wday)) {
                  byweekday.push(wday);
                  continue;
                } else if (isWeekdayStr(wday)) {
                  byweekday.push(Weekday2.fromStr(wday).weekday);
                  continue;
                }
                if (!wday.n || opts.freq > RRule2.MONTHLY) {
                  byweekday.push(wday.weekday);
                } else {
                  bynweekday.push([wday.weekday, wday.n]);
                }
              }
              opts.byweekday = notEmpty(byweekday) ? byweekday : null;
              opts.bynweekday = notEmpty(bynweekday) ? bynweekday : null;
            }
            if (!isPresent(opts.byhour)) {
              opts.byhour = opts.freq < RRule2.HOURLY ? [opts.dtstart.getUTCHours()] : null;
            } else if (isNumber(opts.byhour)) {
              opts.byhour = [opts.byhour];
            }
            if (!isPresent(opts.byminute)) {
              opts.byminute = opts.freq < RRule2.MINUTELY ? [opts.dtstart.getUTCMinutes()] : null;
            } else if (isNumber(opts.byminute)) {
              opts.byminute = [opts.byminute];
            }
            if (!isPresent(opts.bysecond)) {
              opts.bysecond = opts.freq < RRule2.SECONDLY ? [opts.dtstart.getUTCSeconds()] : null;
            } else if (isNumber(opts.bysecond)) {
              opts.bysecond = [opts.bysecond];
            }
            return { parsedOptions: opts };
          }
          __name(parseOptions, "parseOptions");
          function buildTimeset(opts) {
            var millisecondModulo = opts.dtstart.getTime() % 1e3;
            if (!freqIsDailyOrGreater(opts.freq)) {
              return [];
            }
            var timeset = [];
            opts.byhour.forEach(function(hour) {
              opts.byminute.forEach(function(minute) {
                opts.bysecond.forEach(function(second) {
                  timeset.push(new Time(hour, minute, second, millisecondModulo));
                });
              });
            });
            return timeset;
          }
          __name(buildTimeset, "buildTimeset");
          ;
          function parseString(rfcString) {
            var options = rfcString.split("\n").map(parseLine).filter(function(x) {
              return x !== null;
            });
            return __assign(__assign({}, options[0]), options[1]);
          }
          __name(parseString, "parseString");
          function parseDtstart(line) {
            var options = {};
            var dtstartWithZone = /DTSTART(?:;TZID=([^:=]+?))?(?::|=)([^;\s]+)/i.exec(line);
            if (!dtstartWithZone) {
              return options;
            }
            var tzid = dtstartWithZone[1], dtstart = dtstartWithZone[2];
            if (tzid) {
              options.tzid = tzid;
            }
            options.dtstart = untilStringToDate(dtstart);
            return options;
          }
          __name(parseDtstart, "parseDtstart");
          function parseLine(rfcString) {
            rfcString = rfcString.replace(/^\s+|\s+$/, "");
            if (!rfcString.length)
              return null;
            var header = /^([A-Z]+?)[:;]/.exec(rfcString.toUpperCase());
            if (!header) {
              return parseRrule(rfcString);
            }
            var key = header[1];
            switch (key.toUpperCase()) {
              case "RRULE":
              case "EXRULE":
                return parseRrule(rfcString);
              case "DTSTART":
                return parseDtstart(rfcString);
              default:
                throw new Error("Unsupported RFC prop ".concat(key, " in ").concat(rfcString));
            }
          }
          __name(parseLine, "parseLine");
          function parseRrule(line) {
            var strippedLine = line.replace(/^RRULE:/i, "");
            var options = parseDtstart(strippedLine);
            var attrs = line.replace(/^(?:RRULE|EXRULE):/i, "").split(";");
            attrs.forEach(function(attr) {
              var _a = attr.split("="), key = _a[0], value = _a[1];
              switch (key.toUpperCase()) {
                case "FREQ":
                  options.freq = Frequency[value.toUpperCase()];
                  break;
                case "WKST":
                  options.wkst = Days[value.toUpperCase()];
                  break;
                case "COUNT":
                case "INTERVAL":
                case "BYSETPOS":
                case "BYMONTH":
                case "BYMONTHDAY":
                case "BYYEARDAY":
                case "BYWEEKNO":
                case "BYHOUR":
                case "BYMINUTE":
                case "BYSECOND":
                  var num = parseNumber(value);
                  var optionKey = key.toLowerCase();
                  options[optionKey] = num;
                  break;
                case "BYWEEKDAY":
                case "BYDAY":
                  options.byweekday = parseWeekday(value);
                  break;
                case "DTSTART":
                case "TZID":
                  var dtstart = parseDtstart(line);
                  options.tzid = dtstart.tzid;
                  options.dtstart = dtstart.dtstart;
                  break;
                case "UNTIL":
                  options.until = untilStringToDate(value);
                  break;
                case "BYEASTER":
                  options.byeaster = Number(value);
                  break;
                default:
                  throw new Error("Unknown RRULE property '" + key + "'");
              }
            });
            return options;
          }
          __name(parseRrule, "parseRrule");
          function parseNumber(value) {
            if (value.indexOf(",") !== -1) {
              var values = value.split(",");
              return values.map(parseIndividualNumber);
            }
            return parseIndividualNumber(value);
          }
          __name(parseNumber, "parseNumber");
          function parseIndividualNumber(value) {
            if (/^[+-]?\d+$/.test(value)) {
              return Number(value);
            }
            return value;
          }
          __name(parseIndividualNumber, "parseIndividualNumber");
          function parseWeekday(value) {
            var days = value.split(",");
            return days.map(function(day) {
              if (day.length === 2) {
                return Days[day];
              }
              var parts = day.match(/^([+-]?\d{1,2})([A-Z]{2})$/);
              if (!parts || parts.length < 3) {
                throw new SyntaxError("Invalid weekday string: ".concat(day));
              }
              var n = Number(parts[1]);
              var wdaypart = parts[2];
              var wday = Days[wdaypart].weekday;
              return new Weekday2(wday, n);
            });
          }
          __name(parseWeekday, "parseWeekday");
          ;
          var DateWithZone = (
            /** @class */
            function() {
              function DateWithZone2(date, tzid) {
                if (isNaN(date.getTime())) {
                  throw new RangeError("Invalid date passed to DateWithZone");
                }
                this.date = date;
                this.tzid = tzid;
              }
              __name(DateWithZone2, "DateWithZone");
              Object.defineProperty(DateWithZone2.prototype, "isUTC", {
                get: /* @__PURE__ */ __name(function() {
                  return !this.tzid || this.tzid.toUpperCase() === "UTC";
                }, "get"),
                enumerable: false,
                configurable: true
              });
              DateWithZone2.prototype.toString = function() {
                var datestr = timeToUntilString(this.date.getTime(), this.isUTC);
                if (!this.isUTC) {
                  return ";TZID=".concat(this.tzid, ":").concat(datestr);
                }
                return ":".concat(datestr);
              };
              DateWithZone2.prototype.getTime = function() {
                return this.date.getTime();
              };
              DateWithZone2.prototype.rezonedDate = function() {
                if (this.isUTC) {
                  return this.date;
                }
                return dateInTimeZone(this.date, this.tzid);
              };
              return DateWithZone2;
            }()
          );
          ;
          function optionsToString(options) {
            var rrule = [];
            var dtstart = "";
            var keys = Object.keys(options);
            var defaultKeys2 = Object.keys(DEFAULT_OPTIONS);
            for (var i = 0; i < keys.length; i++) {
              if (keys[i] === "tzid")
                continue;
              if (!includes(defaultKeys2, keys[i]))
                continue;
              var key = keys[i].toUpperCase();
              var value = options[keys[i]];
              var outValue = "";
              if (!isPresent(value) || isArray(value) && !value.length)
                continue;
              switch (key) {
                case "FREQ":
                  outValue = RRule2.FREQUENCIES[options.freq];
                  break;
                case "WKST":
                  if (isNumber(value)) {
                    outValue = new Weekday2(value).toString();
                  } else {
                    outValue = value.toString();
                  }
                  break;
                case "BYWEEKDAY":
                  key = "BYDAY";
                  outValue = toArray(value).map(function(wday) {
                    if (wday instanceof Weekday2) {
                      return wday;
                    }
                    if (isArray(wday)) {
                      return new Weekday2(wday[0], wday[1]);
                    }
                    return new Weekday2(wday);
                  }).toString();
                  break;
                case "DTSTART":
                  dtstart = buildDtstart(value, options.tzid);
                  break;
                case "UNTIL":
                  outValue = timeToUntilString(value, !options.tzid);
                  break;
                default:
                  if (isArray(value)) {
                    var strValues = [];
                    for (var j = 0; j < value.length; j++) {
                      strValues[j] = String(value[j]);
                    }
                    outValue = strValues.toString();
                  } else {
                    outValue = String(value);
                  }
              }
              if (outValue) {
                rrule.push([key, outValue]);
              }
            }
            var rules = rrule.map(function(_a) {
              var key2 = _a[0], value2 = _a[1];
              return "".concat(key2, "=").concat(value2.toString());
            }).join(";");
            var ruleString = "";
            if (rules !== "") {
              ruleString = "RRULE:".concat(rules);
            }
            return [dtstart, ruleString].filter(function(x) {
              return !!x;
            }).join("\n");
          }
          __name(optionsToString, "optionsToString");
          function buildDtstart(dtstart, tzid) {
            if (!dtstart) {
              return "";
            }
            return "DTSTART" + new DateWithZone(new Date(dtstart), tzid).toString();
          }
          __name(buildDtstart, "buildDtstart");
          ;
          function argsMatch(left, right) {
            if (Array.isArray(left)) {
              if (!Array.isArray(right))
                return false;
              if (left.length !== right.length)
                return false;
              return left.every(function(date, i) {
                return date.getTime() === right[i].getTime();
              });
            }
            if (left instanceof Date) {
              return right instanceof Date && left.getTime() === right.getTime();
            }
            return left === right;
          }
          __name(argsMatch, "argsMatch");
          var Cache = (
            /** @class */
            function() {
              function Cache2() {
                this.all = false;
                this.before = [];
                this.after = [];
                this.between = [];
              }
              __name(Cache2, "Cache");
              Cache2.prototype._cacheAdd = function(what, value, args) {
                if (value) {
                  value = value instanceof Date ? dateutil_clone(value) : cloneDates(value);
                }
                if (what === "all") {
                  this.all = value;
                } else {
                  args._value = value;
                  this[what].push(args);
                }
              };
              Cache2.prototype._cacheGet = function(what, args) {
                var cached = false;
                var argsKeys = args ? Object.keys(args) : [];
                var findCacheDiff = /* @__PURE__ */ __name(function(item2) {
                  for (var i2 = 0; i2 < argsKeys.length; i2++) {
                    var key = argsKeys[i2];
                    if (!argsMatch(args[key], item2[key])) {
                      return true;
                    }
                  }
                  return false;
                }, "findCacheDiff");
                var cachedObject = this[what];
                if (what === "all") {
                  cached = this.all;
                } else if (isArray(cachedObject)) {
                  for (var i = 0; i < cachedObject.length; i++) {
                    var item = cachedObject[i];
                    if (argsKeys.length && findCacheDiff(item))
                      continue;
                    cached = item._value;
                    break;
                  }
                }
                if (!cached && this.all) {
                  var iterResult = new iterresult(what, args);
                  for (var i = 0; i < this.all.length; i++) {
                    if (!iterResult.accept(this.all[i]))
                      break;
                  }
                  cached = iterResult.getValue();
                  this._cacheAdd(what, cached, args);
                }
                return isArray(cached) ? cloneDates(cached) : cached instanceof Date ? dateutil_clone(cached) : cached;
              };
              return Cache2;
            }()
          );
          ;
          var M365MASK = __spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray([], repeat(1, 31), true), repeat(2, 28), true), repeat(3, 31), true), repeat(4, 30), true), repeat(5, 31), true), repeat(6, 30), true), repeat(7, 31), true), repeat(8, 31), true), repeat(9, 30), true), repeat(10, 31), true), repeat(11, 30), true), repeat(12, 31), true), repeat(1, 7), true);
          var M366MASK = __spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray([], repeat(1, 31), true), repeat(2, 29), true), repeat(3, 31), true), repeat(4, 30), true), repeat(5, 31), true), repeat(6, 30), true), repeat(7, 31), true), repeat(8, 31), true), repeat(9, 30), true), repeat(10, 31), true), repeat(11, 30), true), repeat(12, 31), true), repeat(1, 7), true);
          var M28 = range(1, 29);
          var M29 = range(1, 30);
          var M30 = range(1, 31);
          var M31 = range(1, 32);
          var MDAY366MASK = __spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray([], M31, true), M29, true), M31, true), M30, true), M31, true), M30, true), M31, true), M31, true), M30, true), M31, true), M30, true), M31, true), M31.slice(0, 7), true);
          var MDAY365MASK = __spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray([], M31, true), M28, true), M31, true), M30, true), M31, true), M30, true), M31, true), M31, true), M30, true), M31, true), M30, true), M31, true), M31.slice(0, 7), true);
          var NM28 = range(-28, 0);
          var NM29 = range(-29, 0);
          var NM30 = range(-30, 0);
          var NM31 = range(-31, 0);
          var NMDAY366MASK = __spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray([], NM31, true), NM29, true), NM31, true), NM30, true), NM31, true), NM30, true), NM31, true), NM31, true), NM30, true), NM31, true), NM30, true), NM31, true), NM31.slice(0, 7), true);
          var NMDAY365MASK = __spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray([], NM31, true), NM28, true), NM31, true), NM30, true), NM31, true), NM30, true), NM31, true), NM31, true), NM30, true), NM31, true), NM30, true), NM31, true), NM31.slice(0, 7), true);
          var M366RANGE = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];
          var M365RANGE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
          var WDAYMASK = function() {
            var wdaymask = [];
            for (var i = 0; i < 55; i++)
              wdaymask = wdaymask.concat(range(7));
            return wdaymask;
          }();
          ;
          function rebuildYear(year, options) {
            var firstyday = datetime(year, 1, 1);
            var yearlen = isLeapYear(year) ? 366 : 365;
            var nextyearlen = isLeapYear(year + 1) ? 366 : 365;
            var yearordinal = toOrdinal(firstyday);
            var yearweekday = getWeekday(firstyday);
            var result = __assign(__assign({ yearlen, nextyearlen, yearordinal, yearweekday }, baseYearMasks(year)), { wnomask: null });
            if (empty(options.byweekno)) {
              return result;
            }
            result.wnomask = repeat(0, yearlen + 7);
            var firstwkst;
            var wyearlen;
            var no1wkst = firstwkst = pymod(7 - yearweekday + options.wkst, 7);
            if (no1wkst >= 4) {
              no1wkst = 0;
              wyearlen = result.yearlen + pymod(yearweekday - options.wkst, 7);
            } else {
              wyearlen = yearlen - no1wkst;
            }
            var div = Math.floor(wyearlen / 7);
            var mod = pymod(wyearlen, 7);
            var numweeks = Math.floor(div + mod / 4);
            for (var j = 0; j < options.byweekno.length; j++) {
              var n = options.byweekno[j];
              if (n < 0) {
                n += numweeks + 1;
              }
              if (!(n > 0 && n <= numweeks)) {
                continue;
              }
              var i = void 0;
              if (n > 1) {
                i = no1wkst + (n - 1) * 7;
                if (no1wkst !== firstwkst) {
                  i -= 7 - firstwkst;
                }
              } else {
                i = no1wkst;
              }
              for (var k = 0; k < 7; k++) {
                result.wnomask[i] = 1;
                i++;
                if (result.wdaymask[i] === options.wkst)
                  break;
              }
            }
            if (includes(options.byweekno, 1)) {
              var i = no1wkst + numweeks * 7;
              if (no1wkst !== firstwkst)
                i -= 7 - firstwkst;
              if (i < yearlen) {
                for (var j = 0; j < 7; j++) {
                  result.wnomask[i] = 1;
                  i += 1;
                  if (result.wdaymask[i] === options.wkst)
                    break;
                }
              }
            }
            if (no1wkst) {
              var lnumweeks = void 0;
              if (!includes(options.byweekno, -1)) {
                var lyearweekday = getWeekday(datetime(year - 1, 1, 1));
                var lno1wkst = pymod(7 - lyearweekday.valueOf() + options.wkst, 7);
                var lyearlen = isLeapYear(year - 1) ? 366 : 365;
                var weekst = void 0;
                if (lno1wkst >= 4) {
                  lno1wkst = 0;
                  weekst = lyearlen + pymod(lyearweekday - options.wkst, 7);
                } else {
                  weekst = yearlen - no1wkst;
                }
                lnumweeks = Math.floor(52 + pymod(weekst, 7) / 4);
              } else {
                lnumweeks = -1;
              }
              if (includes(options.byweekno, lnumweeks)) {
                for (var i = 0; i < no1wkst; i++)
                  result.wnomask[i] = 1;
              }
            }
            return result;
          }
          __name(rebuildYear, "rebuildYear");
          function baseYearMasks(year) {
            var yearlen = isLeapYear(year) ? 366 : 365;
            var firstyday = datetime(year, 1, 1);
            var wday = getWeekday(firstyday);
            if (yearlen === 365) {
              return {
                mmask: M365MASK,
                mdaymask: MDAY365MASK,
                nmdaymask: NMDAY365MASK,
                wdaymask: WDAYMASK.slice(wday),
                mrange: M365RANGE
              };
            }
            return {
              mmask: M366MASK,
              mdaymask: MDAY366MASK,
              nmdaymask: NMDAY366MASK,
              wdaymask: WDAYMASK.slice(wday),
              mrange: M366RANGE
            };
          }
          __name(baseYearMasks, "baseYearMasks");
          ;
          function rebuildMonth(year, month, yearlen, mrange, wdaymask, options) {
            var result = {
              lastyear: year,
              lastmonth: month,
              nwdaymask: []
            };
            var ranges = [];
            if (options.freq === RRule2.YEARLY) {
              if (empty(options.bymonth)) {
                ranges = [[0, yearlen]];
              } else {
                for (var j = 0; j < options.bymonth.length; j++) {
                  month = options.bymonth[j];
                  ranges.push(mrange.slice(month - 1, month + 1));
                }
              }
            } else if (options.freq === RRule2.MONTHLY) {
              ranges = [mrange.slice(month - 1, month + 1)];
            }
            if (empty(ranges)) {
              return result;
            }
            result.nwdaymask = repeat(0, yearlen);
            for (var j = 0; j < ranges.length; j++) {
              var rang = ranges[j];
              var first = rang[0];
              var last = rang[1] - 1;
              for (var k = 0; k < options.bynweekday.length; k++) {
                var i = void 0;
                var _a = options.bynweekday[k], wday = _a[0], n = _a[1];
                if (n < 0) {
                  i = last + (n + 1) * 7;
                  i -= pymod(wdaymask[i] - wday, 7);
                } else {
                  i = first + (n - 1) * 7;
                  i += pymod(7 - wdaymask[i] + wday, 7);
                }
                if (first <= i && i <= last)
                  result.nwdaymask[i] = 1;
              }
            }
            return result;
          }
          __name(rebuildMonth, "rebuildMonth");
          ;
          function easter(y, offset) {
            if (offset === void 0) {
              offset = 0;
            }
            var a = y % 19;
            var b = Math.floor(y / 100);
            var c = y % 100;
            var d = Math.floor(b / 4);
            var e = b % 4;
            var f = Math.floor((b + 8) / 25);
            var g = Math.floor((b - f + 1) / 3);
            var h = Math.floor(19 * a + b - d - g + 15) % 30;
            var i = Math.floor(c / 4);
            var k = c % 4;
            var l = Math.floor(32 + 2 * e + 2 * i - h - k) % 7;
            var m = Math.floor((a + 11 * h + 22 * l) / 451);
            var month = Math.floor((h + l - 7 * m + 114) / 31);
            var day = (h + l - 7 * m + 114) % 31 + 1;
            var date = Date.UTC(y, month - 1, day + offset);
            var yearStart = Date.UTC(y, 0, 1);
            return [Math.ceil((date - yearStart) / (1e3 * 60 * 60 * 24))];
          }
          __name(easter, "easter");
          ;
          var Iterinfo = (
            /** @class */
            function() {
              function Iterinfo2(options) {
                this.options = options;
              }
              __name(Iterinfo2, "Iterinfo");
              Iterinfo2.prototype.rebuild = function(year, month) {
                var options = this.options;
                if (year !== this.lastyear) {
                  this.yearinfo = rebuildYear(year, options);
                }
                if (notEmpty(options.bynweekday) && (month !== this.lastmonth || year !== this.lastyear)) {
                  var _a = this.yearinfo, yearlen = _a.yearlen, mrange = _a.mrange, wdaymask = _a.wdaymask;
                  this.monthinfo = rebuildMonth(year, month, yearlen, mrange, wdaymask, options);
                }
                if (isPresent(options.byeaster)) {
                  this.eastermask = easter(year, options.byeaster);
                }
              };
              Object.defineProperty(Iterinfo2.prototype, "lastyear", {
                get: /* @__PURE__ */ __name(function() {
                  return this.monthinfo ? this.monthinfo.lastyear : null;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "lastmonth", {
                get: /* @__PURE__ */ __name(function() {
                  return this.monthinfo ? this.monthinfo.lastmonth : null;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "yearlen", {
                get: /* @__PURE__ */ __name(function() {
                  return this.yearinfo.yearlen;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "yearordinal", {
                get: /* @__PURE__ */ __name(function() {
                  return this.yearinfo.yearordinal;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "mrange", {
                get: /* @__PURE__ */ __name(function() {
                  return this.yearinfo.mrange;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "wdaymask", {
                get: /* @__PURE__ */ __name(function() {
                  return this.yearinfo.wdaymask;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "mmask", {
                get: /* @__PURE__ */ __name(function() {
                  return this.yearinfo.mmask;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "wnomask", {
                get: /* @__PURE__ */ __name(function() {
                  return this.yearinfo.wnomask;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "nwdaymask", {
                get: /* @__PURE__ */ __name(function() {
                  return this.monthinfo ? this.monthinfo.nwdaymask : [];
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "nextyearlen", {
                get: /* @__PURE__ */ __name(function() {
                  return this.yearinfo.nextyearlen;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "mdaymask", {
                get: /* @__PURE__ */ __name(function() {
                  return this.yearinfo.mdaymask;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Object.defineProperty(Iterinfo2.prototype, "nmdaymask", {
                get: /* @__PURE__ */ __name(function() {
                  return this.yearinfo.nmdaymask;
                }, "get"),
                enumerable: false,
                configurable: true
              });
              Iterinfo2.prototype.ydayset = function() {
                return [range(this.yearlen), 0, this.yearlen];
              };
              Iterinfo2.prototype.mdayset = function(_, month) {
                var start = this.mrange[month - 1];
                var end = this.mrange[month];
                var set = repeat(null, this.yearlen);
                for (var i = start; i < end; i++)
                  set[i] = i;
                return [set, start, end];
              };
              Iterinfo2.prototype.wdayset = function(year, month, day) {
                var set = repeat(null, this.yearlen + 7);
                var i = toOrdinal(datetime(year, month, day)) - this.yearordinal;
                var start = i;
                for (var j = 0; j < 7; j++) {
                  set[i] = i;
                  ++i;
                  if (this.wdaymask[i] === this.options.wkst)
                    break;
                }
                return [set, start, i];
              };
              Iterinfo2.prototype.ddayset = function(year, month, day) {
                var set = repeat(null, this.yearlen);
                var i = toOrdinal(datetime(year, month, day)) - this.yearordinal;
                set[i] = i;
                return [set, i, i + 1];
              };
              Iterinfo2.prototype.htimeset = function(hour, _, second, millisecond) {
                var _this = this;
                var set = [];
                this.options.byminute.forEach(function(minute) {
                  set = set.concat(_this.mtimeset(hour, minute, second, millisecond));
                });
                sort(set);
                return set;
              };
              Iterinfo2.prototype.mtimeset = function(hour, minute, _, millisecond) {
                var set = this.options.bysecond.map(function(second) {
                  return new Time(hour, minute, second, millisecond);
                });
                sort(set);
                return set;
              };
              Iterinfo2.prototype.stimeset = function(hour, minute, second, millisecond) {
                return [new Time(hour, minute, second, millisecond)];
              };
              Iterinfo2.prototype.getdayset = function(freq) {
                switch (freq) {
                  case Frequency.YEARLY:
                    return this.ydayset.bind(this);
                  case Frequency.MONTHLY:
                    return this.mdayset.bind(this);
                  case Frequency.WEEKLY:
                    return this.wdayset.bind(this);
                  case Frequency.DAILY:
                    return this.ddayset.bind(this);
                  default:
                    return this.ddayset.bind(this);
                }
              };
              Iterinfo2.prototype.gettimeset = function(freq) {
                switch (freq) {
                  case Frequency.HOURLY:
                    return this.htimeset.bind(this);
                  case Frequency.MINUTELY:
                    return this.mtimeset.bind(this);
                  case Frequency.SECONDLY:
                    return this.stimeset.bind(this);
                }
              };
              return Iterinfo2;
            }()
          );
          const iterinfo = Iterinfo;
          ;
          function buildPoslist(bysetpos, timeset, start, end, ii, dayset) {
            var poslist = [];
            for (var j = 0; j < bysetpos.length; j++) {
              var daypos = void 0;
              var timepos = void 0;
              var pos = bysetpos[j];
              if (pos < 0) {
                daypos = Math.floor(pos / timeset.length);
                timepos = pymod(pos, timeset.length);
              } else {
                daypos = Math.floor((pos - 1) / timeset.length);
                timepos = pymod(pos - 1, timeset.length);
              }
              var tmp = [];
              for (var k = start; k < end; k++) {
                var val = dayset[k];
                if (!isPresent(val))
                  continue;
                tmp.push(val);
              }
              var i = void 0;
              if (daypos < 0) {
                i = tmp.slice(daypos)[0];
              } else {
                i = tmp[daypos];
              }
              var time = timeset[timepos];
              var date = fromOrdinal(ii.yearordinal + i);
              var res = combine(date, time);
              if (!includes(poslist, res))
                poslist.push(res);
            }
            sort(poslist);
            return poslist;
          }
          __name(buildPoslist, "buildPoslist");
          ;
          function iter(iterResult, options) {
            var dtstart = options.dtstart, freq = options.freq, interval = options.interval, until = options.until, bysetpos = options.bysetpos;
            var count = options.count;
            if (count === 0 || interval === 0) {
              return emitResult(iterResult);
            }
            var counterDate = DateTime.fromDate(dtstart);
            var ii = new iterinfo(options);
            ii.rebuild(counterDate.year, counterDate.month);
            var timeset = makeTimeset(ii, counterDate, options);
            for (; ; ) {
              var _a = ii.getdayset(freq)(counterDate.year, counterDate.month, counterDate.day), dayset = _a[0], start = _a[1], end = _a[2];
              var filtered = removeFilteredDays(dayset, start, end, ii, options);
              if (notEmpty(bysetpos)) {
                var poslist = buildPoslist(bysetpos, timeset, start, end, ii, dayset);
                for (var j = 0; j < poslist.length; j++) {
                  var res = poslist[j];
                  if (until && res > until) {
                    return emitResult(iterResult);
                  }
                  if (res >= dtstart) {
                    var rezonedDate = rezoneIfNeeded(res, options);
                    if (!iterResult.accept(rezonedDate)) {
                      return emitResult(iterResult);
                    }
                    if (count) {
                      --count;
                      if (!count) {
                        return emitResult(iterResult);
                      }
                    }
                  }
                }
              } else {
                for (var j = start; j < end; j++) {
                  var currentDay = dayset[j];
                  if (!isPresent(currentDay)) {
                    continue;
                  }
                  var date = fromOrdinal(ii.yearordinal + currentDay);
                  for (var k = 0; k < timeset.length; k++) {
                    var time = timeset[k];
                    var res = combine(date, time);
                    if (until && res > until) {
                      return emitResult(iterResult);
                    }
                    if (res >= dtstart) {
                      var rezonedDate = rezoneIfNeeded(res, options);
                      if (!iterResult.accept(rezonedDate)) {
                        return emitResult(iterResult);
                      }
                      if (count) {
                        --count;
                        if (!count) {
                          return emitResult(iterResult);
                        }
                      }
                    }
                  }
                }
              }
              if (options.interval === 0) {
                return emitResult(iterResult);
              }
              counterDate.add(options, filtered);
              if (counterDate.year > MAXYEAR) {
                return emitResult(iterResult);
              }
              if (!freqIsDailyOrGreater(freq)) {
                timeset = ii.gettimeset(freq)(counterDate.hour, counterDate.minute, counterDate.second, 0);
              }
              ii.rebuild(counterDate.year, counterDate.month);
            }
          }
          __name(iter, "iter");
          function isFiltered(ii, currentDay, options) {
            var bymonth = options.bymonth, byweekno = options.byweekno, byweekday = options.byweekday, byeaster = options.byeaster, bymonthday = options.bymonthday, bynmonthday = options.bynmonthday, byyearday = options.byyearday;
            return notEmpty(bymonth) && !includes(bymonth, ii.mmask[currentDay]) || notEmpty(byweekno) && !ii.wnomask[currentDay] || notEmpty(byweekday) && !includes(byweekday, ii.wdaymask[currentDay]) || notEmpty(ii.nwdaymask) && !ii.nwdaymask[currentDay] || byeaster !== null && !includes(ii.eastermask, currentDay) || (notEmpty(bymonthday) || notEmpty(bynmonthday)) && !includes(bymonthday, ii.mdaymask[currentDay]) && !includes(bynmonthday, ii.nmdaymask[currentDay]) || notEmpty(byyearday) && (currentDay < ii.yearlen && !includes(byyearday, currentDay + 1) && !includes(byyearday, -ii.yearlen + currentDay) || currentDay >= ii.yearlen && !includes(byyearday, currentDay + 1 - ii.yearlen) && !includes(byyearday, -ii.nextyearlen + currentDay - ii.yearlen));
          }
          __name(isFiltered, "isFiltered");
          function rezoneIfNeeded(date, options) {
            return new DateWithZone(date, options.tzid).rezonedDate();
          }
          __name(rezoneIfNeeded, "rezoneIfNeeded");
          function emitResult(iterResult) {
            return iterResult.getValue();
          }
          __name(emitResult, "emitResult");
          function removeFilteredDays(dayset, start, end, ii, options) {
            var filtered = false;
            for (var dayCounter = start; dayCounter < end; dayCounter++) {
              var currentDay = dayset[dayCounter];
              filtered = isFiltered(ii, currentDay, options);
              if (filtered)
                dayset[currentDay] = null;
            }
            return filtered;
          }
          __name(removeFilteredDays, "removeFilteredDays");
          function makeTimeset(ii, counterDate, options) {
            var freq = options.freq, byhour = options.byhour, byminute = options.byminute, bysecond = options.bysecond;
            if (freqIsDailyOrGreater(freq)) {
              return buildTimeset(options);
            }
            if (freq >= RRule2.HOURLY && notEmpty(byhour) && !includes(byhour, counterDate.hour) || freq >= RRule2.MINUTELY && notEmpty(byminute) && !includes(byminute, counterDate.minute) || freq >= RRule2.SECONDLY && notEmpty(bysecond) && !includes(bysecond, counterDate.second)) {
              return [];
            }
            return ii.gettimeset(freq)(counterDate.hour, counterDate.minute, counterDate.second, counterDate.millisecond);
          }
          __name(makeTimeset, "makeTimeset");
          ;
          var Days = {
            MO: new Weekday2(0),
            TU: new Weekday2(1),
            WE: new Weekday2(2),
            TH: new Weekday2(3),
            FR: new Weekday2(4),
            SA: new Weekday2(5),
            SU: new Weekday2(6)
          };
          var DEFAULT_OPTIONS = {
            freq: Frequency.YEARLY,
            dtstart: null,
            interval: 1,
            wkst: Days.MO,
            count: null,
            until: null,
            tzid: null,
            bysetpos: null,
            bymonth: null,
            bymonthday: null,
            bynmonthday: null,
            byyearday: null,
            byweekno: null,
            byweekday: null,
            bynweekday: null,
            byhour: null,
            byminute: null,
            bysecond: null,
            byeaster: null
          };
          var defaultKeys = Object.keys(DEFAULT_OPTIONS);
          var RRule2 = (
            /** @class */
            function() {
              function RRule3(options, noCache) {
                if (options === void 0) {
                  options = {};
                }
                if (noCache === void 0) {
                  noCache = false;
                }
                this._cache = noCache ? null : new Cache();
                this.origOptions = initializeOptions(options);
                var parsedOptions = parseOptions(options).parsedOptions;
                this.options = parsedOptions;
              }
              __name(RRule3, "RRule");
              RRule3.parseText = function(text2, language) {
                return parseText(text2, language);
              };
              RRule3.fromText = function(text2, language) {
                return fromText(text2, language);
              };
              RRule3.fromString = function(str) {
                return new RRule3(RRule3.parseString(str) || void 0);
              };
              RRule3.prototype._iter = function(iterResult) {
                return iter(iterResult, this.options);
              };
              RRule3.prototype._cacheGet = function(what, args) {
                if (!this._cache)
                  return false;
                return this._cache._cacheGet(what, args);
              };
              RRule3.prototype._cacheAdd = function(what, value, args) {
                if (!this._cache)
                  return;
                return this._cache._cacheAdd(what, value, args);
              };
              RRule3.prototype.all = function(iterator) {
                if (iterator) {
                  return this._iter(new callbackiterresult("all", {}, iterator));
                }
                var result = this._cacheGet("all");
                if (result === false) {
                  result = this._iter(new iterresult("all", {}));
                  this._cacheAdd("all", result);
                }
                return result;
              };
              RRule3.prototype.between = function(after, before, inc, iterator) {
                if (inc === void 0) {
                  inc = false;
                }
                if (!isValidDate(after) || !isValidDate(before)) {
                  throw new Error("Invalid date passed in to RRule.between");
                }
                var args = {
                  before,
                  after,
                  inc
                };
                if (iterator) {
                  return this._iter(new callbackiterresult("between", args, iterator));
                }
                var result = this._cacheGet("between", args);
                if (result === false) {
                  result = this._iter(new iterresult("between", args));
                  this._cacheAdd("between", result, args);
                }
                return result;
              };
              RRule3.prototype.before = function(dt, inc) {
                if (inc === void 0) {
                  inc = false;
                }
                if (!isValidDate(dt)) {
                  throw new Error("Invalid date passed in to RRule.before");
                }
                var args = { dt, inc };
                var result = this._cacheGet("before", args);
                if (result === false) {
                  result = this._iter(new iterresult("before", args));
                  this._cacheAdd("before", result, args);
                }
                return result;
              };
              RRule3.prototype.after = function(dt, inc) {
                if (inc === void 0) {
                  inc = false;
                }
                if (!isValidDate(dt)) {
                  throw new Error("Invalid date passed in to RRule.after");
                }
                var args = { dt, inc };
                var result = this._cacheGet("after", args);
                if (result === false) {
                  result = this._iter(new iterresult("after", args));
                  this._cacheAdd("after", result, args);
                }
                return result;
              };
              RRule3.prototype.count = function() {
                return this.all().length;
              };
              RRule3.prototype.toString = function() {
                return optionsToString(this.origOptions);
              };
              RRule3.prototype.toText = function(gettext, language, dateFormatter) {
                return toText(this, gettext, language, dateFormatter);
              };
              RRule3.prototype.isFullyConvertibleToText = function() {
                return isFullyConvertible(this);
              };
              RRule3.prototype.clone = function() {
                return new RRule3(this.origOptions);
              };
              RRule3.FREQUENCIES = [
                "YEARLY",
                "MONTHLY",
                "WEEKLY",
                "DAILY",
                "HOURLY",
                "MINUTELY",
                "SECONDLY"
              ];
              RRule3.YEARLY = Frequency.YEARLY;
              RRule3.MONTHLY = Frequency.MONTHLY;
              RRule3.WEEKLY = Frequency.WEEKLY;
              RRule3.DAILY = Frequency.DAILY;
              RRule3.HOURLY = Frequency.HOURLY;
              RRule3.MINUTELY = Frequency.MINUTELY;
              RRule3.SECONDLY = Frequency.SECONDLY;
              RRule3.MO = Days.MO;
              RRule3.TU = Days.TU;
              RRule3.WE = Days.WE;
              RRule3.TH = Days.TH;
              RRule3.FR = Days.FR;
              RRule3.SA = Days.SA;
              RRule3.SU = Days.SU;
              RRule3.parseString = parseString;
              RRule3.optionsToString = optionsToString;
              return RRule3;
            }()
          );
          ;
          function iterSet(iterResult, _rrule, _exrule, _rdate, _exdate, tzid) {
            var _exdateHash = {};
            var _accept = iterResult.accept;
            function evalExdate(after, before) {
              _exrule.forEach(function(rrule) {
                rrule.between(after, before, true).forEach(function(date) {
                  _exdateHash[Number(date)] = true;
                });
              });
            }
            __name(evalExdate, "evalExdate");
            _exdate.forEach(function(date) {
              var zonedDate2 = new DateWithZone(date, tzid).rezonedDate();
              _exdateHash[Number(zonedDate2)] = true;
            });
            iterResult.accept = function(date) {
              var dt = Number(date);
              if (isNaN(dt))
                return _accept.call(this, date);
              if (!_exdateHash[dt]) {
                evalExdate(new Date(dt - 1), new Date(dt + 1));
                if (!_exdateHash[dt]) {
                  _exdateHash[dt] = true;
                  return _accept.call(this, date);
                }
              }
              return true;
            };
            if (iterResult.method === "between") {
              evalExdate(iterResult.args.after, iterResult.args.before);
              iterResult.accept = function(date) {
                var dt = Number(date);
                if (!_exdateHash[dt]) {
                  _exdateHash[dt] = true;
                  return _accept.call(this, date);
                }
                return true;
              };
            }
            for (var i = 0; i < _rdate.length; i++) {
              var zonedDate = new DateWithZone(_rdate[i], tzid).rezonedDate();
              if (!iterResult.accept(new Date(zonedDate.getTime())))
                break;
            }
            _rrule.forEach(function(rrule) {
              iter(iterResult, rrule.options);
            });
            var res = iterResult._result;
            sort(res);
            switch (iterResult.method) {
              case "all":
              case "between":
                return res;
              case "before":
                return res.length && res[res.length - 1] || null;
              case "after":
              default:
                return res.length && res[0] || null;
            }
          }
          __name(iterSet, "iterSet");
          ;
          var rrulestr_DEFAULT_OPTIONS = {
            dtstart: null,
            cache: false,
            unfold: false,
            forceset: false,
            compatible: false,
            tzid: null
          };
          function parseInput(s, options) {
            var rrulevals = [];
            var rdatevals = [];
            var exrulevals = [];
            var exdatevals = [];
            var parsedDtstart = parseDtstart(s);
            var dtstart = parsedDtstart.dtstart;
            var tzid = parsedDtstart.tzid;
            var lines = splitIntoLines(s, options.unfold);
            lines.forEach(function(line) {
              var _a;
              if (!line)
                return;
              var _b = breakDownLine(line), name = _b.name, parms = _b.parms, value = _b.value;
              switch (name.toUpperCase()) {
                case "RRULE":
                  if (parms.length) {
                    throw new Error("unsupported RRULE parm: ".concat(parms.join(",")));
                  }
                  rrulevals.push(parseString(line));
                  break;
                case "RDATE":
                  var _c = (_a = /RDATE(?:;TZID=([^:=]+))?/i.exec(line)) !== null && _a !== void 0 ? _a : [], rdateTzid = _c[1];
                  if (rdateTzid && !tzid) {
                    tzid = rdateTzid;
                  }
                  rdatevals = rdatevals.concat(parseRDate(value, parms));
                  break;
                case "EXRULE":
                  if (parms.length) {
                    throw new Error("unsupported EXRULE parm: ".concat(parms.join(",")));
                  }
                  exrulevals.push(parseString(value));
                  break;
                case "EXDATE":
                  exdatevals = exdatevals.concat(parseRDate(value, parms));
                  break;
                case "DTSTART":
                  break;
                default:
                  throw new Error("unsupported property: " + name);
              }
            });
            return {
              dtstart,
              tzid,
              rrulevals,
              rdatevals,
              exrulevals,
              exdatevals
            };
          }
          __name(parseInput, "parseInput");
          function buildRule2(s, options) {
            var _a = parseInput(s, options), rrulevals = _a.rrulevals, rdatevals = _a.rdatevals, exrulevals = _a.exrulevals, exdatevals = _a.exdatevals, dtstart = _a.dtstart, tzid = _a.tzid;
            var noCache = options.cache === false;
            if (options.compatible) {
              options.forceset = true;
              options.unfold = true;
            }
            if (options.forceset || rrulevals.length > 1 || rdatevals.length || exrulevals.length || exdatevals.length) {
              var rset_1 = new RRuleSet(noCache);
              rset_1.dtstart(dtstart);
              rset_1.tzid(tzid || void 0);
              rrulevals.forEach(function(val2) {
                rset_1.rrule(new RRule2(groomRruleOptions(val2, dtstart, tzid), noCache));
              });
              rdatevals.forEach(function(date) {
                rset_1.rdate(date);
              });
              exrulevals.forEach(function(val2) {
                rset_1.exrule(new RRule2(groomRruleOptions(val2, dtstart, tzid), noCache));
              });
              exdatevals.forEach(function(date) {
                rset_1.exdate(date);
              });
              if (options.compatible && options.dtstart)
                rset_1.rdate(dtstart);
              return rset_1;
            }
            var val = rrulevals[0] || {};
            return new RRule2(groomRruleOptions(val, val.dtstart || options.dtstart || dtstart, val.tzid || options.tzid || tzid), noCache);
          }
          __name(buildRule2, "buildRule");
          function rrulestr(s, options) {
            if (options === void 0) {
              options = {};
            }
            return buildRule2(s, rrulestr_initializeOptions(options));
          }
          __name(rrulestr, "rrulestr");
          function groomRruleOptions(val, dtstart, tzid) {
            return __assign(__assign({}, val), { dtstart, tzid });
          }
          __name(groomRruleOptions, "groomRruleOptions");
          function rrulestr_initializeOptions(options) {
            var invalid = [];
            var keys = Object.keys(options);
            var defaultKeys2 = Object.keys(rrulestr_DEFAULT_OPTIONS);
            keys.forEach(function(key) {
              if (!includes(defaultKeys2, key))
                invalid.push(key);
            });
            if (invalid.length) {
              throw new Error("Invalid options: " + invalid.join(", "));
            }
            return __assign(__assign({}, rrulestr_DEFAULT_OPTIONS), options);
          }
          __name(rrulestr_initializeOptions, "rrulestr_initializeOptions");
          function extractName(line) {
            if (line.indexOf(":") === -1) {
              return {
                name: "RRULE",
                value: line
              };
            }
            var _a = split(line, ":", 1), name = _a[0], value = _a[1];
            return {
              name,
              value
            };
          }
          __name(extractName, "extractName");
          function breakDownLine(line) {
            var _a = extractName(line), name = _a.name, value = _a.value;
            var parms = name.split(";");
            if (!parms)
              throw new Error("empty property name");
            return {
              name: parms[0].toUpperCase(),
              parms: parms.slice(1),
              value
            };
          }
          __name(breakDownLine, "breakDownLine");
          function splitIntoLines(s, unfold) {
            if (unfold === void 0) {
              unfold = false;
            }
            s = s && s.trim();
            if (!s)
              throw new Error("Invalid empty string");
            if (!unfold) {
              return s.split(/\s/);
            }
            var lines = s.split("\n");
            var i = 0;
            while (i < lines.length) {
              var line = lines[i] = lines[i].replace(/\s+$/g, "");
              if (!line) {
                lines.splice(i, 1);
              } else if (i > 0 && line[0] === " ") {
                lines[i - 1] += line.slice(1);
                lines.splice(i, 1);
              } else {
                i += 1;
              }
            }
            return lines;
          }
          __name(splitIntoLines, "splitIntoLines");
          function validateDateParm(parms) {
            parms.forEach(function(parm) {
              if (!/(VALUE=DATE(-TIME)?)|(TZID=)/.test(parm)) {
                throw new Error("unsupported RDATE/EXDATE parm: " + parm);
              }
            });
          }
          __name(validateDateParm, "validateDateParm");
          function parseRDate(rdateval, parms) {
            validateDateParm(parms);
            return rdateval.split(",").map(function(datestr) {
              return untilStringToDate(datestr);
            });
          }
          __name(parseRDate, "parseRDate");
          ;
          function createGetterSetter(fieldName) {
            var _this = this;
            return function(field) {
              if (field !== void 0) {
                _this["_".concat(fieldName)] = field;
              }
              if (_this["_".concat(fieldName)] !== void 0) {
                return _this["_".concat(fieldName)];
              }
              for (var i = 0; i < _this._rrule.length; i++) {
                var field_1 = _this._rrule[i].origOptions[fieldName];
                if (field_1) {
                  return field_1;
                }
              }
            };
          }
          __name(createGetterSetter, "createGetterSetter");
          var RRuleSet = (
            /** @class */
            function(_super) {
              __extends(RRuleSet2, _super);
              function RRuleSet2(noCache) {
                if (noCache === void 0) {
                  noCache = false;
                }
                var _this = _super.call(this, {}, noCache) || this;
                _this.dtstart = createGetterSetter.apply(_this, ["dtstart"]);
                _this.tzid = createGetterSetter.apply(_this, ["tzid"]);
                _this._rrule = [];
                _this._rdate = [];
                _this._exrule = [];
                _this._exdate = [];
                return _this;
              }
              __name(RRuleSet2, "RRuleSet");
              RRuleSet2.prototype._iter = function(iterResult) {
                return iterSet(iterResult, this._rrule, this._exrule, this._rdate, this._exdate, this.tzid());
              };
              RRuleSet2.prototype.rrule = function(rrule) {
                _addRule(rrule, this._rrule);
              };
              RRuleSet2.prototype.exrule = function(rrule) {
                _addRule(rrule, this._exrule);
              };
              RRuleSet2.prototype.rdate = function(date) {
                _addDate(date, this._rdate);
              };
              RRuleSet2.prototype.exdate = function(date) {
                _addDate(date, this._exdate);
              };
              RRuleSet2.prototype.rrules = function() {
                return this._rrule.map(function(e) {
                  return rrulestr(e.toString());
                });
              };
              RRuleSet2.prototype.exrules = function() {
                return this._exrule.map(function(e) {
                  return rrulestr(e.toString());
                });
              };
              RRuleSet2.prototype.rdates = function() {
                return this._rdate.map(function(e) {
                  return new Date(e.getTime());
                });
              };
              RRuleSet2.prototype.exdates = function() {
                return this._exdate.map(function(e) {
                  return new Date(e.getTime());
                });
              };
              RRuleSet2.prototype.valueOf = function() {
                var result = [];
                if (!this._rrule.length && this._dtstart) {
                  result = result.concat(optionsToString({ dtstart: this._dtstart }));
                }
                this._rrule.forEach(function(rrule) {
                  result = result.concat(rrule.toString().split("\n"));
                });
                this._exrule.forEach(function(exrule) {
                  result = result.concat(exrule.toString().split("\n").map(function(line) {
                    return line.replace(/^RRULE:/, "EXRULE:");
                  }).filter(function(line) {
                    return !/^DTSTART/.test(line);
                  }));
                });
                if (this._rdate.length) {
                  result.push(rdatesToString("RDATE", this._rdate, this.tzid()));
                }
                if (this._exdate.length) {
                  result.push(rdatesToString("EXDATE", this._exdate, this.tzid()));
                }
                return result;
              };
              RRuleSet2.prototype.toString = function() {
                return this.valueOf().join("\n");
              };
              RRuleSet2.prototype.clone = function() {
                var rrs = new RRuleSet2(!!this._cache);
                this._rrule.forEach(function(rule) {
                  return rrs.rrule(rule.clone());
                });
                this._exrule.forEach(function(rule) {
                  return rrs.exrule(rule.clone());
                });
                this._rdate.forEach(function(date) {
                  return rrs.rdate(new Date(date.getTime()));
                });
                this._exdate.forEach(function(date) {
                  return rrs.exdate(new Date(date.getTime()));
                });
                return rrs;
              };
              return RRuleSet2;
            }(RRule2)
          );
          function _addRule(rrule, collection) {
            if (!(rrule instanceof RRule2)) {
              throw new TypeError(String(rrule) + " is not RRule instance");
            }
            if (!includes(collection.map(String), String(rrule))) {
              collection.push(rrule);
            }
          }
          __name(_addRule, "_addRule");
          function _addDate(date, collection) {
            if (!(date instanceof Date)) {
              throw new TypeError(String(date) + " is not Date instance");
            }
            if (!includes(collection.map(Number), Number(date))) {
              collection.push(date);
              sort(collection);
            }
          }
          __name(_addDate, "_addDate");
          function rdatesToString(param, rdates, tzid) {
            var isUTC = !tzid || tzid.toUpperCase() === "UTC";
            var header = isUTC ? "".concat(param, ":") : "".concat(param, ";TZID=").concat(tzid, ":");
            var dateString = rdates.map(function(rdate) {
              return timeToUntilString(rdate.valueOf(), isUTC);
            }).join(",");
            return "".concat(header).concat(dateString);
          }
          __name(rdatesToString, "rdatesToString");
          ;
          return __webpack_exports__;
        })()
      );
    });
  }
});

// ../../packages/plugin-sdk/dist/index.js
var CALL_TIMEOUT_MS = 3e4;
var PROBE_TIMEOUT_MS = 1500;
function hostPort() {
  const globals = globalThis;
  return globals.process?.parentPort ?? null;
}
__name(hostPort, "hostPort");
function describe(err) {
  return err instanceof Error ? err.message : String(err);
}
__name(describe, "describe");
function plugin(handlers) {
  const host = hostPort();
  if (!host) {
    throw new Error("pi plugin SDK: no host port. A plugin backend must be started by the host (it is forked as a child process); running it directly cannot work.");
  }
  let panelPort = null;
  const panelPorts = /* @__PURE__ */ new Map();
  const portPanel = /* @__PURE__ */ new Map();
  let pluginId = "";
  let dataDir = "";
  let booted = false;
  let seq = 0;
  const pending = /* @__PURE__ */ new Map();
  const mountWarned = /* @__PURE__ */ new Set();
  let portClosed = false;
  let probeSeq = 0;
  const pendingProbes = /* @__PURE__ */ new Map();
  function routeFor(panelId) {
    if (panelId) {
      const ports = panelPorts.get(panelId);
      if (ports && ports.size > 0)
        return [...ports];
    }
    return panelPort ? [panelPort] : [];
  }
  __name(routeFor, "routeFor");
  const post = /* @__PURE__ */ __name((message) => host.postMessage(message), "post");
  const log = /* @__PURE__ */ __name((level, message) => post({ type: "log", level, message }), "log");
  const ctx2 = {
    get pluginId() {
      return pluginId;
    },
    get dataDir() {
      return dataDir;
    },
    call(method, params = {}, options) {
      return new Promise((resolve, reject) => {
        const id = "c" + ++seq;
        pending.set(id, { resolve, reject });
        post({ type: "call", id, method, params });
        setTimeout(() => {
          if (pending.delete(id))
            reject(new Error(`capability timeout: ${method}`));
        }, options?.timeoutMs ?? CALL_TIMEOUT_MS);
      });
    },
    send(panelId, event, data) {
      const ports = routeFor(panelId);
      if (ports.length === 0)
        return false;
      let delivered = false;
      for (const port of ports) {
        try {
          port.postMessage({ kind: "event", event, panelId, data });
          delivered = true;
        } catch {
        }
      }
      return delivered;
    },
    panelAlive(panelId, timeoutMs = PROBE_TIMEOUT_MS) {
      const ports = routeFor(panelId);
      if (ports.length === 0)
        return Promise.resolve(false);
      const id = "probe-" + ++probeSeq;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingProbes.delete(id);
          resolve(false);
        }, timeoutMs);
        pendingProbes.set(id, () => {
          clearTimeout(timer);
          resolve(true);
        });
        for (const port of ports) {
          try {
            port.postMessage({ kind: "event", event: "pi.probe", panelId, data: { id } });
          } catch {
          }
        }
      });
    },
    async openPanel(panelId, options) {
      return ctx2.call("panel.open", { panelId, focus: options?.focus !== false });
    },
    async setBadge(panelId, badge) {
      await ctx2.call("panel.setStatus", { panelId, badge: badge ?? "" }).catch(() => {
      });
    },
    log: {
      info: /* @__PURE__ */ __name((m) => log("info", m), "info"),
      warn: /* @__PURE__ */ __name((m) => log("warn", m), "warn"),
      error: /* @__PURE__ */ __name((m) => log("error", m), "error")
    }
  };
  async function runTool(msg) {
    const id = msg.id ?? "";
    const name = msg.name ?? "";
    if (!booted) {
      post({
        type: "tool-result",
        id,
        error: `tool "${name}" arrived before the host sent init \u2014 no plugin id or data dir yet. If you are testing the backend directly, send { type: 'init', pluginId, dataDir } first.`
      });
      return;
    }
    if (!handlers.onTool) {
      post({ type: "tool-result", id, error: `this plugin contributes no tools (asked for "${name}")` });
      return;
    }
    try {
      const result = await handlers.onTool(name, msg.params ?? {}, ctx2, {
        sessionId: msg.sessionId,
        workspaceId: msg.workspaceId
      });
      if (result === void 0 || result === null) {
        post({
          type: "tool-result",
          id,
          error: `tool "${name}" returned nothing. Return a string, or an object with content/details/card.`
        });
        return;
      }
      if (typeof result === "string") {
        post({ type: "tool-result", id, content: [{ type: "text", text: result }] });
        return;
      }
      post({ type: "tool-result", id, ...result });
    } catch (err) {
      post({ type: "tool-result", id, error: describe(err) });
    }
  }
  __name(runTool, "runTool");
  async function onPanelMessage(raw, sourcePort) {
    const msg = raw;
    if (!msg || typeof msg !== "object")
      return;
    if (msg.kind === "request") {
      const id = String(msg.id ?? "");
      const method = String(msg.method ?? "");
      const panelId = msg.panelId ?? "";
      const replyPort = sourcePort ?? routeFor(panelId)[0];
      const reply = /* @__PURE__ */ __name((ok, error, result) => {
        replyPort?.postMessage({ kind: "response", id, ok, panelId, error, result });
      }, "reply");
      if (!panelId) {
        log("warn", `panel request "${method}" arrived with no panel id \u2014 cannot attribute it.`);
      }
      if (!handlers.onRequest) {
        reply(false, `this plugin handles no panel requests (asked for "${method}")`);
        return;
      }
      if (!booted) {
        reply(false, `request "${method}" arrived before the host sent init \u2014 no plugin id or data dir yet.`);
        return;
      }
      try {
        const result = await handlers.onRequest(panelId, method, msg.params ?? {}, ctx2);
        if (result === void 0) {
          reply(false, `onRequest handled "${method}" without returning anything. Return the answer (a value, or true), or rethrow for a method you do not handle.`);
          return;
        }
        reply(true, void 0, result);
      } catch (err) {
        reply(false, describe(err));
      }
      return;
    }
    if (msg.kind === "event") {
      const event = String(msg.event ?? "");
      const panelId = msg.panelId ?? "";
      if (event === "pi.probe.reply") {
        const probeId = String(msg.data?.id ?? "");
        const resolve = pendingProbes.get(probeId);
        if (resolve) {
          pendingProbes.delete(probeId);
          resolve();
        }
        return;
      }
      if (!panelId)
        log("warn", `panel event "${event}" arrived with no panel id.`);
      if (event === "panel.mounted") {
        if (!handlers.onPanelMounted) {
          if (!mountWarned.has(panelId)) {
            mountWarned.add(panelId);
            log("warn", `panel "${panelId}" mounted but nothing was drawn: this plugin has no onPanelMounted handler. Add one and push the panel's first state from there.`);
          }
          return;
        }
        try {
          const data = msg.data ?? {};
          await handlers.onPanelMounted(panelId, data.params, ctx2, {
            sessionId: data.sessionId,
            workspaceId: data.workspaceId
          });
        } catch (err) {
          log("error", `onPanelMounted for "${panelId}" threw: ${describe(err)}`);
        }
        return;
      }
      if (!handlers.onEvent) {
        log("warn", `panel event "${event}" ignored: this plugin handles no events.`);
        return;
      }
      try {
        await handlers.onEvent(panelId, event, msg.data, ctx2);
      } catch (err) {
        log("error", `panel event "${event}" handler threw: ${describe(err)}`);
      }
      return;
    }
    log("warn", `unrecognised panel message (kind=${String(msg.kind)}) \u2014 ignored`);
  }
  __name(onPanelMessage, "onPanelMessage");
  host.on("message", (event) => {
    const msg = event.data ?? {};
    switch (msg.type) {
      case "init":
        pluginId = msg.pluginId ?? "";
        dataDir = msg.dataDir ?? "";
        booted = true;
        Promise.resolve(handlers.onInit?.(ctx2)).catch((err) => log("error", `onInit threw: ${describe(err)}`));
        break;
      case "call-result": {
        const entry = pending.get(msg.id ?? "");
        if (entry) {
          pending.delete(msg.id ?? "");
          if (msg.error)
            entry.reject(new Error(msg.error));
          else
            entry.resolve(msg.result);
        }
        break;
      }
      case "tool-call":
        void runTool(msg);
        break;
      case "command":
        if (!handlers.onCommand) {
          post({ type: "command-result", id: msg.id, error: `this plugin contributes no commands` });
          break;
        }
        Promise.resolve(handlers.onCommand(msg.name ?? "", msg.args, ctx2)).then((result) => post({ type: "command-result", id: msg.id, result })).catch((err) => post({ type: "command-result", id: msg.id, error: describe(err) }));
        break;
      case "context-request":
        if (!handlers.onContextRequest) {
          post({ type: "context-result", id: msg.id, error: `this plugin contributes no context providers` });
          break;
        }
        Promise.resolve(handlers.onContextRequest(msg.providerId ?? "", msg.message ?? "", ctx2)).then((text2) => post({ type: "context-result", id: msg.id, text: text2 ?? "" })).catch((err) => post({ type: "context-result", id: msg.id, error: describe(err) }));
        break;
      case "host-event":
        try {
          handlers.onHostEvent?.(msg.event ?? "", msg.data, ctx2);
        } catch (err) {
          log("error", `host event "${String(msg.event)}" handler threw: ${describe(err)}`);
        }
        break;
      case "card-event": {
        if (!handlers.onCardEvent) {
          log("warn", `card event "${String(msg.eventId)}" on ${String(msg.toolName)} ignored \u2014 implement onCardEvent`);
          break;
        }
        try {
          handlers.onCardEvent(msg.toolName ?? "", msg.eventId ?? "", msg.kind === "submit" ? "submit" : "click", msg.payload, ctx2);
        } catch (err) {
          log("error", `card event "${String(msg.eventId)}" handler threw: ${describe(err)}`);
        }
        break;
      }
      case "ui-port": {
        const port = event.ports?.[0];
        if (!port)
          break;
        panelPort = port;
        portClosed = false;
        port.on("message", (e) => {
          const pid = e.data?.panelId;
          if (pid) {
            portPanel.set(port, pid);
            const ports = panelPorts.get(pid) ?? /* @__PURE__ */ new Set();
            ports.add(port);
            panelPorts.set(pid, ports);
          }
          void onPanelMessage(e.data, port);
        });
        try {
          port.on("close", () => {
            const pid = portPanel.get(port);
            if (pid) {
              const ports = panelPorts.get(pid);
              ports?.delete(port);
              if (ports && ports.size === 0)
                panelPorts.delete(pid);
            }
            portPanel.delete(port);
            if (panelPort === port) {
              const last = [...panelPorts.values()].at(-1);
              panelPort = last ? [...last].at(-1) ?? null : null;
              if (!panelPort)
                portClosed = true;
            }
          });
        } catch {
        }
        port.start?.();
        break;
      }
      default:
        break;
    }
  });
  post({ type: "ready" });
}
__name(plugin, "plugin");

// node_modules/chrono-node/dist/esm/types.js
var Meridiem;
(function(Meridiem2) {
  Meridiem2[Meridiem2["AM"] = 0] = "AM";
  Meridiem2[Meridiem2["PM"] = 1] = "PM";
})(Meridiem || (Meridiem = {}));
var Weekday;
(function(Weekday2) {
  Weekday2[Weekday2["SUNDAY"] = 0] = "SUNDAY";
  Weekday2[Weekday2["MONDAY"] = 1] = "MONDAY";
  Weekday2[Weekday2["TUESDAY"] = 2] = "TUESDAY";
  Weekday2[Weekday2["WEDNESDAY"] = 3] = "WEDNESDAY";
  Weekday2[Weekday2["THURSDAY"] = 4] = "THURSDAY";
  Weekday2[Weekday2["FRIDAY"] = 5] = "FRIDAY";
  Weekday2[Weekday2["SATURDAY"] = 6] = "SATURDAY";
})(Weekday || (Weekday = {}));
var Month;
(function(Month2) {
  Month2[Month2["JANUARY"] = 1] = "JANUARY";
  Month2[Month2["FEBRUARY"] = 2] = "FEBRUARY";
  Month2[Month2["MARCH"] = 3] = "MARCH";
  Month2[Month2["APRIL"] = 4] = "APRIL";
  Month2[Month2["MAY"] = 5] = "MAY";
  Month2[Month2["JUNE"] = 6] = "JUNE";
  Month2[Month2["JULY"] = 7] = "JULY";
  Month2[Month2["AUGUST"] = 8] = "AUGUST";
  Month2[Month2["SEPTEMBER"] = 9] = "SEPTEMBER";
  Month2[Month2["OCTOBER"] = 10] = "OCTOBER";
  Month2[Month2["NOVEMBER"] = 11] = "NOVEMBER";
  Month2[Month2["DECEMBER"] = 12] = "DECEMBER";
})(Month || (Month = {}));

// node_modules/chrono-node/dist/esm/utils/dates.js
function assignSimilarDate(component, target) {
  component.assign("day", target.getDate());
  component.assign("month", target.getMonth() + 1);
  component.assign("year", target.getFullYear());
}
__name(assignSimilarDate, "assignSimilarDate");
function assignSimilarTime(component, target) {
  component.assign("hour", target.getHours());
  component.assign("minute", target.getMinutes());
  component.assign("second", target.getSeconds());
  component.assign("millisecond", target.getMilliseconds());
  component.assign("meridiem", target.getHours() < 12 ? Meridiem.AM : Meridiem.PM);
}
__name(assignSimilarTime, "assignSimilarTime");
function implySimilarDate(component, target) {
  component.imply("day", target.getDate());
  component.imply("month", target.getMonth() + 1);
  component.imply("year", target.getFullYear());
}
__name(implySimilarDate, "implySimilarDate");
function implySimilarTime(component, target) {
  component.imply("hour", target.getHours());
  component.imply("minute", target.getMinutes());
  component.imply("second", target.getSeconds());
  component.imply("millisecond", target.getMilliseconds());
  component.imply("meridiem", target.getHours() < 12 ? Meridiem.AM : Meridiem.PM);
}
__name(implySimilarTime, "implySimilarTime");

// node_modules/chrono-node/dist/esm/timezone.js
var TIMEZONE_ABBR_MAP = {
  ACDT: 630,
  ACST: 570,
  ADT: -180,
  AEDT: 660,
  AEST: 600,
  AFT: 270,
  AKDT: -480,
  AKST: -540,
  ALMT: 360,
  AMST: -180,
  AMT: -240,
  ANAST: 720,
  ANAT: 720,
  AQTT: 300,
  ART: -180,
  AST: -240,
  AWDT: 540,
  AWST: 480,
  AZOST: 0,
  AZOT: -60,
  AZST: 300,
  AZT: 240,
  BNT: 480,
  BOT: -240,
  BRST: -120,
  BRT: -180,
  BST: 60,
  BTT: 360,
  CAST: 480,
  CAT: 120,
  CCT: 390,
  CDT: -300,
  CEST: 120,
  CET: {
    timezoneOffsetDuringDst: 2 * 60,
    timezoneOffsetNonDst: 60,
    dstStart: /* @__PURE__ */ __name((year) => getLastWeekdayOfMonth(year, Month.MARCH, Weekday.SUNDAY, 2), "dstStart"),
    dstEnd: /* @__PURE__ */ __name((year) => getLastWeekdayOfMonth(year, Month.OCTOBER, Weekday.SUNDAY, 3), "dstEnd")
  },
  CHADT: 825,
  CHAST: 765,
  CKT: -600,
  CLST: -180,
  CLT: -240,
  COT: -300,
  CST: -360,
  CT: {
    timezoneOffsetDuringDst: -5 * 60,
    timezoneOffsetNonDst: -6 * 60,
    dstStart: /* @__PURE__ */ __name((year) => getNthWeekdayOfMonth(year, Month.MARCH, Weekday.SUNDAY, 2, 2), "dstStart"),
    dstEnd: /* @__PURE__ */ __name((year) => getNthWeekdayOfMonth(year, Month.NOVEMBER, Weekday.SUNDAY, 1, 2), "dstEnd")
  },
  CVT: -60,
  CXT: 420,
  ChST: 600,
  DAVT: 420,
  EASST: -300,
  EAST: -360,
  EAT: 180,
  ECT: -300,
  EDT: -240,
  EEST: 180,
  EET: 120,
  EGST: 0,
  EGT: -60,
  EST: -300,
  ET: {
    timezoneOffsetDuringDst: -4 * 60,
    timezoneOffsetNonDst: -5 * 60,
    dstStart: /* @__PURE__ */ __name((year) => getNthWeekdayOfMonth(year, Month.MARCH, Weekday.SUNDAY, 2, 2), "dstStart"),
    dstEnd: /* @__PURE__ */ __name((year) => getNthWeekdayOfMonth(year, Month.NOVEMBER, Weekday.SUNDAY, 1, 2), "dstEnd")
  },
  FJST: 780,
  FJT: 720,
  FKST: -180,
  FKT: -240,
  FNT: -120,
  GALT: -360,
  GAMT: -540,
  GET: 240,
  GFT: -180,
  GILT: 720,
  GMT: 0,
  GST: 240,
  GYT: -240,
  HAA: -180,
  HAC: -300,
  HADT: -540,
  HAE: -240,
  HAP: -420,
  HAR: -360,
  HAST: -600,
  HAT: -90,
  HAY: -480,
  HKT: 480,
  HLV: -210,
  HNA: -240,
  HNC: -360,
  HNE: -300,
  HNP: -480,
  HNR: -420,
  HNT: -150,
  HNY: -540,
  HOVT: 420,
  ICT: 420,
  IDT: 180,
  IOT: 360,
  IRDT: 270,
  IRKST: 540,
  IRKT: 540,
  IRST: 210,
  IST: 330,
  JST: 540,
  KGT: 360,
  KRAST: 480,
  KRAT: 480,
  KST: 540,
  KUYT: 240,
  LHDT: 660,
  LHST: 630,
  LINT: 840,
  MAGST: 720,
  MAGT: 720,
  MART: -510,
  MAWT: 300,
  MDT: -360,
  MESZ: 120,
  MEZ: 60,
  MHT: 720,
  MMT: 390,
  MSD: 240,
  MSK: 180,
  MST: -420,
  MT: {
    timezoneOffsetDuringDst: -6 * 60,
    timezoneOffsetNonDst: -7 * 60,
    dstStart: /* @__PURE__ */ __name((year) => getNthWeekdayOfMonth(year, Month.MARCH, Weekday.SUNDAY, 2, 2), "dstStart"),
    dstEnd: /* @__PURE__ */ __name((year) => getNthWeekdayOfMonth(year, Month.NOVEMBER, Weekday.SUNDAY, 1, 2), "dstEnd")
  },
  MUT: 240,
  MVT: 300,
  MYT: 480,
  NCT: 660,
  NDT: -90,
  NFT: 690,
  NOVST: 420,
  NOVT: 360,
  NPT: 345,
  NST: -150,
  NUT: -660,
  NZDT: 780,
  NZST: 720,
  OMSST: 420,
  OMST: 420,
  PDT: -420,
  PET: -300,
  PETST: 720,
  PETT: 720,
  PGT: 600,
  PHOT: 780,
  PHT: 480,
  PKT: 300,
  PMDT: -120,
  PMST: -180,
  PONT: 660,
  PST: -480,
  PT: {
    timezoneOffsetDuringDst: -7 * 60,
    timezoneOffsetNonDst: -8 * 60,
    dstStart: /* @__PURE__ */ __name((year) => getNthWeekdayOfMonth(year, Month.MARCH, Weekday.SUNDAY, 2, 2), "dstStart"),
    dstEnd: /* @__PURE__ */ __name((year) => getNthWeekdayOfMonth(year, Month.NOVEMBER, Weekday.SUNDAY, 1, 2), "dstEnd")
  },
  PWT: 540,
  PYST: -180,
  PYT: -240,
  RET: 240,
  SAMT: 240,
  SAST: 120,
  SBT: 660,
  SCT: 240,
  SGT: 480,
  SRT: -180,
  SST: -660,
  TAHT: -600,
  TFT: 300,
  TJT: 300,
  TKT: 780,
  TLT: 540,
  TMT: 300,
  TVT: 720,
  ULAT: 480,
  UTC: 0,
  UYST: -120,
  UYT: -180,
  UZT: 300,
  VET: -210,
  VLAST: 660,
  VLAT: 660,
  VUT: 660,
  WAST: 120,
  WAT: 60,
  WEST: 60,
  WESZ: 60,
  WET: 0,
  WEZ: 0,
  WFT: 720,
  WGST: -120,
  WGT: -180,
  WIB: 420,
  WIT: 540,
  WITA: 480,
  WST: 780,
  WT: 0,
  YAKST: 600,
  YAKT: 600,
  YAPT: 600,
  YEKST: 360,
  YEKT: 360
};
function getNthWeekdayOfMonth(year, month, weekday, n, hour = 0) {
  let dayOfMonth = 0;
  let i = 0;
  while (i < n) {
    dayOfMonth++;
    const date = new Date(year, month - 1, dayOfMonth);
    if (date.getDay() === weekday)
      i++;
  }
  return new Date(year, month - 1, dayOfMonth, hour);
}
__name(getNthWeekdayOfMonth, "getNthWeekdayOfMonth");
function getLastWeekdayOfMonth(year, month, weekday, hour = 0) {
  const oneIndexedWeekday = weekday === 0 ? 7 : weekday;
  const date = new Date(year, month - 1 + 1, 1, 12);
  const firstWeekdayNextMonth = date.getDay() === 0 ? 7 : date.getDay();
  let dayDiff;
  if (firstWeekdayNextMonth === oneIndexedWeekday)
    dayDiff = 7;
  else if (firstWeekdayNextMonth < oneIndexedWeekday)
    dayDiff = 7 + firstWeekdayNextMonth - oneIndexedWeekday;
  else
    dayDiff = firstWeekdayNextMonth - oneIndexedWeekday;
  date.setDate(date.getDate() - dayDiff);
  return new Date(year, month - 1, date.getDate(), hour);
}
__name(getLastWeekdayOfMonth, "getLastWeekdayOfMonth");
function toTimezoneOffset(timezoneInput, date, timezoneOverrides = {}) {
  if (timezoneInput == null) {
    return null;
  }
  if (typeof timezoneInput === "number") {
    return timezoneInput;
  }
  const matchedTimezone = timezoneOverrides[timezoneInput] ?? TIMEZONE_ABBR_MAP[timezoneInput];
  if (matchedTimezone == null) {
    return null;
  }
  if (typeof matchedTimezone == "number") {
    return matchedTimezone;
  }
  if (date == null) {
    return null;
  }
  if (date > matchedTimezone.dstStart(date.getFullYear()) && !(date > matchedTimezone.dstEnd(date.getFullYear()))) {
    return matchedTimezone.timezoneOffsetDuringDst;
  }
  return matchedTimezone.timezoneOffsetNonDst;
}
__name(toTimezoneOffset, "toTimezoneOffset");

// node_modules/chrono-node/dist/esm/calculation/duration.js
var EmptyDuration = {
  day: 0,
  second: 0,
  millisecond: 0
};
function addDuration(ref, duration) {
  let date = new Date(ref);
  if (duration["y"]) {
    duration["year"] = duration["y"];
    delete duration["y"];
  }
  if (duration["mo"]) {
    duration["month"] = duration["mo"];
    delete duration["mo"];
  }
  if (duration["M"]) {
    duration["month"] = duration["M"];
    delete duration["M"];
  }
  if (duration["w"]) {
    duration["week"] = duration["w"];
    delete duration["w"];
  }
  if (duration["d"]) {
    duration["day"] = duration["d"];
    delete duration["d"];
  }
  if (duration["h"]) {
    duration["hour"] = duration["h"];
    delete duration["h"];
  }
  if (duration["m"]) {
    duration["minute"] = duration["m"];
    delete duration["m"];
  }
  if (duration["s"]) {
    duration["second"] = duration["s"];
    delete duration["s"];
  }
  if (duration["ms"]) {
    duration["millisecond"] = duration["ms"];
    delete duration["ms"];
  }
  if ("year" in duration) {
    const floor = Math.floor(duration["year"]);
    date.setFullYear(date.getFullYear() + floor);
    const remainingFraction = duration["year"] - floor;
    if (remainingFraction > 0) {
      duration.month = duration?.month ?? 0;
      duration.month += remainingFraction * 12;
    }
  }
  if ("quarter" in duration) {
    const floor = Math.floor(duration["quarter"]);
    date.setMonth(date.getMonth() + floor * 3);
  }
  if ("month" in duration) {
    const floor = Math.floor(duration["month"]);
    date.setMonth(date.getMonth() + floor);
    const remainingFraction = duration["month"] - floor;
    if (remainingFraction > 0) {
      duration.week = duration?.week ?? 0;
      duration.week += remainingFraction * 4;
    }
  }
  if ("week" in duration) {
    const floor = Math.floor(duration["week"]);
    date.setDate(date.getDate() + floor * 7);
    const remainingFraction = duration["week"] - floor;
    if (remainingFraction > 0) {
      duration.day = duration?.day ?? 0;
      duration.day += Math.round(remainingFraction * 7);
    }
  }
  if ("day" in duration) {
    const floor = Math.floor(duration["day"]);
    date.setDate(date.getDate() + floor);
    const remainingFraction = duration["day"] - floor;
    if (remainingFraction > 0) {
      duration.hour = duration?.hour ?? 0;
      duration.hour += Math.round(remainingFraction * 24);
    }
  }
  if ("hour" in duration) {
    const floor = Math.floor(duration["hour"]);
    date.setHours(date.getHours() + floor);
    const remainingFraction = duration["hour"] - floor;
    if (remainingFraction > 0) {
      duration.minute = duration?.minute ?? 0;
      duration.minute += Math.round(remainingFraction * 60);
    }
  }
  if ("minute" in duration) {
    const floor = Math.floor(duration["minute"]);
    date.setMinutes(date.getMinutes() + floor);
    const remainingFraction = duration["minute"] - floor;
    if (remainingFraction > 0) {
      duration.second = duration?.second ?? 0;
      duration.second += Math.round(remainingFraction * 60);
    }
  }
  if ("second" in duration) {
    const floor = Math.floor(duration["second"]);
    date.setSeconds(date.getSeconds() + floor);
    const remainingFraction = duration["second"] - floor;
    if (remainingFraction > 0) {
      duration.millisecond = duration?.millisecond ?? 0;
      duration.millisecond += Math.round(remainingFraction * 1e3);
    }
  }
  if ("millisecond" in duration) {
    const floor = Math.floor(duration["millisecond"]);
    date.setMilliseconds(date.getMilliseconds() + floor);
  }
  return date;
}
__name(addDuration, "addDuration");
function reverseDuration(duration) {
  const reversed = {};
  for (const key in duration) {
    reversed[key] = -duration[key];
  }
  return reversed;
}
__name(reverseDuration, "reverseDuration");

// node_modules/chrono-node/dist/esm/results.js
var ReferenceWithTimezone = class _ReferenceWithTimezone {
  static {
    __name(this, "ReferenceWithTimezone");
  }
  instant;
  timezoneOffset;
  constructor(instant, timezoneOffset) {
    this.instant = instant ?? /* @__PURE__ */ new Date();
    this.timezoneOffset = timezoneOffset ?? null;
  }
  static fromDate(date) {
    return new _ReferenceWithTimezone(date);
  }
  static fromInput(input, timezoneOverrides) {
    if (input instanceof Date) {
      return _ReferenceWithTimezone.fromDate(input);
    }
    const instant = input?.instant ?? /* @__PURE__ */ new Date();
    const timezoneOffset = toTimezoneOffset(input?.timezone, instant, timezoneOverrides);
    return new _ReferenceWithTimezone(instant, timezoneOffset);
  }
  getDateWithAdjustedTimezone() {
    const date = new Date(this.instant);
    if (this.timezoneOffset !== null) {
      date.setMinutes(date.getMinutes() - this.getSystemTimezoneAdjustmentMinute(this.instant));
    }
    return date;
  }
  getSystemTimezoneAdjustmentMinute(date, overrideTimezoneOffset) {
    if (!date) {
      date = /* @__PURE__ */ new Date();
    }
    const currentTimezoneOffset = -date.getTimezoneOffset();
    const targetTimezoneOffset = overrideTimezoneOffset ?? this.timezoneOffset ?? currentTimezoneOffset;
    return currentTimezoneOffset - targetTimezoneOffset;
  }
  getTimezoneOffset() {
    return this.timezoneOffset ?? -this.instant.getTimezoneOffset();
  }
};
var ParsingComponents = class _ParsingComponents {
  static {
    __name(this, "ParsingComponents");
  }
  knownValues;
  impliedValues;
  reference;
  _tags = /* @__PURE__ */ new Set();
  constructor(reference, knownComponents) {
    this.reference = reference;
    this.knownValues = {};
    this.impliedValues = {};
    if (knownComponents) {
      for (const key in knownComponents) {
        this.knownValues[key] = knownComponents[key];
      }
    }
    const date = reference.getDateWithAdjustedTimezone();
    this.imply("day", date.getDate());
    this.imply("month", date.getMonth() + 1);
    this.imply("year", date.getFullYear());
    this.imply("hour", 12);
    this.imply("minute", 0);
    this.imply("second", 0);
    this.imply("millisecond", 0);
  }
  static createRelativeFromReference(reference, duration = EmptyDuration) {
    let date = addDuration(reference.getDateWithAdjustedTimezone(), duration);
    const components = new _ParsingComponents(reference);
    components.addTag("result/relativeDate");
    if ("hour" in duration || "minute" in duration || "second" in duration || "millisecond" in duration) {
      components.addTag("result/relativeDateAndTime");
      assignSimilarTime(components, date);
      assignSimilarDate(components, date);
      components.assign("timezoneOffset", reference.getTimezoneOffset());
    } else {
      implySimilarTime(components, date);
      components.imply("timezoneOffset", reference.getTimezoneOffset());
      if ("day" in duration) {
        components.assign("day", date.getDate());
        components.assign("month", date.getMonth() + 1);
        components.assign("year", date.getFullYear());
        components.assign("weekday", date.getDay());
      } else if ("week" in duration) {
        components.assign("day", date.getDate());
        components.assign("month", date.getMonth() + 1);
        components.assign("year", date.getFullYear());
        components.imply("weekday", date.getDay());
      } else {
        components.imply("day", date.getDate());
        if ("month" in duration) {
          components.assign("month", date.getMonth() + 1);
          components.assign("year", date.getFullYear());
        } else {
          components.imply("month", date.getMonth() + 1);
          if ("year" in duration) {
            components.assign("year", date.getFullYear());
          } else {
            components.imply("year", date.getFullYear());
          }
        }
      }
    }
    return components;
  }
  get(component) {
    if (component in this.knownValues) {
      return this.knownValues[component];
    }
    if (component in this.impliedValues) {
      return this.impliedValues[component];
    }
    return null;
  }
  isCertain(component) {
    return component in this.knownValues;
  }
  getCertainComponents() {
    return Object.keys(this.knownValues);
  }
  imply(component, value) {
    if (component in this.knownValues) {
      return this;
    }
    this.impliedValues[component] = value;
    return this;
  }
  assign(component, value) {
    this.knownValues[component] = value;
    delete this.impliedValues[component];
    return this;
  }
  addDurationAsImplied(duration) {
    const currentDate = this.dateWithoutTimezoneAdjustment();
    const date = addDuration(currentDate, duration);
    if ("day" in duration || "week" in duration || "month" in duration || "year" in duration) {
      this.delete(["day", "weekday", "month", "year"]);
      this.imply("day", date.getDate());
      this.imply("weekday", date.getDay());
      this.imply("month", date.getMonth() + 1);
      this.imply("year", date.getFullYear());
    }
    if ("second" in duration || "minute" in duration || "hour" in duration) {
      this.delete(["second", "minute", "hour"]);
      this.imply("second", date.getSeconds());
      this.imply("minute", date.getMinutes());
      this.imply("hour", date.getHours());
    }
    return this;
  }
  delete(components) {
    if (typeof components === "string") {
      components = [components];
    }
    for (const component of components) {
      delete this.knownValues[component];
      delete this.impliedValues[component];
    }
  }
  clone() {
    const component = new _ParsingComponents(this.reference);
    component.knownValues = {};
    component.impliedValues = {};
    for (const key in this.knownValues) {
      component.knownValues[key] = this.knownValues[key];
    }
    for (const key in this.impliedValues) {
      component.impliedValues[key] = this.impliedValues[key];
    }
    return component;
  }
  isOnlyDate() {
    return !this.isCertain("hour") && !this.isCertain("minute") && !this.isCertain("second");
  }
  isOnlyTime() {
    return !this.isCertain("weekday") && !this.isCertain("day") && !this.isCertain("month") && !this.isCertain("year");
  }
  isOnlyWeekdayComponent() {
    return this.isCertain("weekday") && !this.isCertain("day") && !this.isCertain("month");
  }
  isDateWithUnknownYear() {
    return this.isCertain("month") && !this.isCertain("year");
  }
  isValidDate() {
    const date = new Date(Date.UTC(this.get("year"), this.get("month") - 1, this.get("day"), this.get("hour"), this.get("minute"), this.get("second"), this.get("millisecond")));
    date.setUTCFullYear(this.get("year"));
    if (date.getUTCFullYear() !== this.get("year"))
      return false;
    if (date.getUTCMonth() !== this.get("month") - 1)
      return false;
    if (date.getUTCDate() !== this.get("day"))
      return false;
    if (this.get("hour") != null && date.getUTCHours() != this.get("hour"))
      return false;
    if (this.get("minute") != null && date.getUTCMinutes() != this.get("minute"))
      return false;
    return true;
  }
  toString() {
    return `[ParsingComponents {
            tags: ${JSON.stringify(Array.from(this._tags).sort())}, 
            knownValues: ${JSON.stringify(this.knownValues)}, 
            impliedValues: ${JSON.stringify(this.impliedValues)}}, 
            reference: ${JSON.stringify(this.reference)}]`;
  }
  date() {
    const timezoneOffset = this.get("timezoneOffset") ?? this.reference.timezoneOffset;
    if (timezoneOffset === null || timezoneOffset === void 0) {
      return this.dateWithoutTimezoneAdjustment();
    }
    const date = new Date(Date.UTC(this.get("year"), this.get("month") - 1, this.get("day"), this.get("hour"), this.get("minute"), this.get("second"), this.get("millisecond")));
    date.setUTCFullYear(this.get("year"));
    return new Date(date.getTime() - timezoneOffset * 6e4);
  }
  addTag(tag) {
    this._tags.add(tag);
    return this;
  }
  addTags(tags) {
    for (const tag of tags) {
      this._tags.add(tag);
    }
    return this;
  }
  tags() {
    return new Set(this._tags);
  }
  dateWithoutTimezoneAdjustment() {
    const date = new Date(this.get("year"), this.get("month") - 1, this.get("day"), this.get("hour"), this.get("minute"), this.get("second"), this.get("millisecond"));
    date.setFullYear(this.get("year"));
    return date;
  }
};
var ParsingResult = class _ParsingResult {
  static {
    __name(this, "ParsingResult");
  }
  refDate;
  index;
  text;
  reference;
  start;
  end;
  constructor(reference, index, text2, start, end) {
    this.reference = reference;
    this.refDate = reference.instant;
    this.index = index;
    this.text = text2;
    this.start = start || new ParsingComponents(reference);
    this.end = end;
  }
  clone() {
    const result = new _ParsingResult(this.reference, this.index, this.text);
    result.start = this.start ? this.start.clone() : null;
    result.end = this.end ? this.end.clone() : null;
    return result;
  }
  date() {
    return this.start.date();
  }
  addTag(tag) {
    this.start.addTag(tag);
    if (this.end) {
      this.end.addTag(tag);
    }
    return this;
  }
  addTags(tags) {
    this.start.addTags(tags);
    if (this.end) {
      this.end.addTags(tags);
    }
    return this;
  }
  tags() {
    const combinedTags = new Set(this.start.tags());
    if (this.end) {
      for (const tag of this.end.tags()) {
        combinedTags.add(tag);
      }
    }
    return combinedTags;
  }
  toString() {
    const tags = Array.from(this.tags()).sort();
    return `[ParsingResult {index: ${this.index}, text: '${this.text}', tags: ${JSON.stringify(tags)} ...}]`;
  }
};

// node_modules/chrono-node/dist/esm/utils/pattern.js
function repeatedTimeunitPattern(prefix, singleTimeunitPattern, connectorPattern = "\\s{0,5},?\\s{0,5}") {
  const singleTimeunitPatternNoCapture = singleTimeunitPattern.replace(/\((?!\?)/g, "(?:");
  return `${prefix}${singleTimeunitPatternNoCapture}(?:${connectorPattern}${singleTimeunitPatternNoCapture}){0,10}`;
}
__name(repeatedTimeunitPattern, "repeatedTimeunitPattern");
function extractTerms(dictionary) {
  let keys;
  if (dictionary instanceof Array) {
    keys = [...dictionary];
  } else if (dictionary instanceof Map) {
    keys = Array.from(dictionary.keys());
  } else {
    keys = Object.keys(dictionary);
  }
  return keys;
}
__name(extractTerms, "extractTerms");
function matchAnyPattern(dictionary) {
  const joinedTerms = extractTerms(dictionary).sort((a, b) => b.length - a.length).join("|").replace(/\./g, "\\.");
  return `(?:${joinedTerms})`;
}
__name(matchAnyPattern, "matchAnyPattern");

// node_modules/chrono-node/dist/esm/calculation/years.js
function findMostLikelyADYear(yearNumber) {
  if (yearNumber < 100) {
    if (yearNumber > 50) {
      yearNumber = yearNumber + 1900;
    } else {
      yearNumber = yearNumber + 2e3;
    }
  }
  return yearNumber;
}
__name(findMostLikelyADYear, "findMostLikelyADYear");
function findYearClosestToRef(refDate, day, month) {
  let date = new Date(refDate);
  date.setMonth(month - 1);
  date.setDate(day);
  const nextYear = addDuration(date, { "year": 1 });
  const lastYear = addDuration(date, { "year": -1 });
  if (Math.abs(nextYear.getTime() - refDate.getTime()) < Math.abs(date.getTime() - refDate.getTime())) {
    date = nextYear;
  } else if (Math.abs(lastYear.getTime() - refDate.getTime()) < Math.abs(date.getTime() - refDate.getTime())) {
    date = lastYear;
  }
  return date.getFullYear();
}
__name(findYearClosestToRef, "findYearClosestToRef");

// node_modules/chrono-node/dist/esm/locales/en/constants.js
var WEEKDAY_DICTIONARY = {
  sunday: 0,
  sun: 0,
  "sun.": 0,
  monday: 1,
  mon: 1,
  "mon.": 1,
  tuesday: 2,
  tue: 2,
  "tue.": 2,
  wednesday: 3,
  wed: 3,
  "wed.": 3,
  thursday: 4,
  thurs: 4,
  "thurs.": 4,
  thur: 4,
  "thur.": 4,
  thu: 4,
  "thu.": 4,
  friday: 5,
  fri: 5,
  "fri.": 5,
  saturday: 6,
  sat: 6,
  "sat.": 6
};
var FULL_MONTH_NAME_DICTIONARY = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};
var MONTH_DICTIONARY = {
  ...FULL_MONTH_NAME_DICTIONARY,
  jan: 1,
  "jan.": 1,
  feb: 2,
  "feb.": 2,
  mar: 3,
  "mar.": 3,
  apr: 4,
  "apr.": 4,
  jun: 6,
  "jun.": 6,
  jul: 7,
  "jul.": 7,
  aug: 8,
  "aug.": 8,
  sep: 9,
  "sep.": 9,
  sept: 9,
  "sept.": 9,
  oct: 10,
  "oct.": 10,
  nov: 11,
  "nov.": 11,
  dec: 12,
  "dec.": 12
};
var INTEGER_WORD_DICTIONARY = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
};
var ORDINAL_WORD_DICTIONARY = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  "twenty first": 21,
  "twenty-first": 21,
  "twenty second": 22,
  "twenty-second": 22,
  "twenty third": 23,
  "twenty-third": 23,
  "twenty fourth": 24,
  "twenty-fourth": 24,
  "twenty fifth": 25,
  "twenty-fifth": 25,
  "twenty sixth": 26,
  "twenty-sixth": 26,
  "twenty seventh": 27,
  "twenty-seventh": 27,
  "twenty eighth": 28,
  "twenty-eighth": 28,
  "twenty ninth": 29,
  "twenty-ninth": 29,
  "thirtieth": 30,
  "thirty first": 31,
  "thirty-first": 31
};
var TIME_UNIT_DICTIONARY_NO_ABBR = {
  second: "second",
  seconds: "second",
  minute: "minute",
  minutes: "minute",
  hour: "hour",
  hours: "hour",
  day: "day",
  days: "day",
  week: "week",
  weeks: "week",
  month: "month",
  months: "month",
  quarter: "quarter",
  quarters: "quarter",
  year: "year",
  years: "year"
};
var TIME_UNIT_DICTIONARY = {
  s: "second",
  sec: "second",
  second: "second",
  seconds: "second",
  m: "minute",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  h: "hour",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
  d: "day",
  day: "day",
  days: "day",
  w: "week",
  week: "week",
  weeks: "week",
  mo: "month",
  mon: "month",
  mos: "month",
  month: "month",
  months: "month",
  qtr: "quarter",
  quarter: "quarter",
  quarters: "quarter",
  y: "year",
  yr: "year",
  year: "year",
  years: "year",
  ...TIME_UNIT_DICTIONARY_NO_ABBR
};
var NUMBER_PATTERN = `(?:${matchAnyPattern(INTEGER_WORD_DICTIONARY)}|[0-9]+|[0-9]+\\.[0-9]+|half(?:\\s{0,2}an?)?|an?\\b(?:\\s{0,2}few)?|few|several|the|a?\\s{0,2}couple\\s{0,2}(?:of)?)`;
function parseNumberPattern(match) {
  const num = match.toLowerCase();
  if (INTEGER_WORD_DICTIONARY[num] !== void 0) {
    return INTEGER_WORD_DICTIONARY[num];
  } else if (num === "a" || num === "an" || num == "the") {
    return 1;
  } else if (num.match(/few/)) {
    return 3;
  } else if (num.match(/half/)) {
    return 0.5;
  } else if (num.match(/couple/)) {
    return 2;
  } else if (num.match(/several/)) {
    return 7;
  }
  return parseFloat(num);
}
__name(parseNumberPattern, "parseNumberPattern");
var ORDINAL_NUMBER_PATTERN = `(?:${matchAnyPattern(ORDINAL_WORD_DICTIONARY)}|[0-9]{1,2}(?:st|nd|rd|th)?)`;
function parseOrdinalNumberPattern(match) {
  let num = match.toLowerCase();
  if (ORDINAL_WORD_DICTIONARY[num] !== void 0) {
    return ORDINAL_WORD_DICTIONARY[num];
  }
  num = num.replace(/(?:st|nd|rd|th)$/i, "");
  return parseInt(num);
}
__name(parseOrdinalNumberPattern, "parseOrdinalNumberPattern");
var YEAR_PATTERN = `(?:[1-9][0-9]{0,3}\\s{0,2}(?:BE|AD|BC|BCE|CE)|[1-9][0-9]{3}|[0-9]{2}(?!\\w|:\\d|\\s+(?:am|pm|o\\s*clock|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))`;
function parseYear(match) {
  if (/BE/i.test(match)) {
    match = match.replace(/BE/i, "");
    return parseInt(match) - 543;
  }
  if (/BCE?/i.test(match)) {
    match = match.replace(/BCE?/i, "");
    return -parseInt(match);
  }
  if (/(AD|CE)/i.test(match)) {
    match = match.replace(/(AD|CE)/i, "");
    return parseInt(match);
  }
  const rawYearNumber = parseInt(match);
  return findMostLikelyADYear(rawYearNumber);
}
__name(parseYear, "parseYear");
var SINGLE_TIME_UNIT_PATTERN = `(${NUMBER_PATTERN})\\s{0,3}(${matchAnyPattern(TIME_UNIT_DICTIONARY)})`;
var SINGLE_TIME_UNIT_REGEX = new RegExp(SINGLE_TIME_UNIT_PATTERN, "i");
var SINGLE_TIME_UNIT_NO_ABBR_PATTERN = `(${NUMBER_PATTERN})\\s{0,3}(${matchAnyPattern(TIME_UNIT_DICTIONARY_NO_ABBR)})`;
var TIME_UNIT_CONNECTOR_PATTERN = `\\s{0,5},?(?:\\s*and)?\\s{0,5}`;
var TIME_UNITS_PATTERN = repeatedTimeunitPattern(`(?:(?:about|around)\\s{0,3})?`, SINGLE_TIME_UNIT_PATTERN, TIME_UNIT_CONNECTOR_PATTERN);
var TIME_UNITS_NO_ABBR_PATTERN = repeatedTimeunitPattern(`(?:(?:about|around)\\s{0,3})?`, SINGLE_TIME_UNIT_NO_ABBR_PATTERN, TIME_UNIT_CONNECTOR_PATTERN);
function parseDuration(timeunitText) {
  const fragments = {};
  let remainingText = timeunitText;
  let match = SINGLE_TIME_UNIT_REGEX.exec(remainingText);
  while (match) {
    collectDateTimeFragment(fragments, match);
    remainingText = remainingText.substring(match[0].length).trim();
    match = SINGLE_TIME_UNIT_REGEX.exec(remainingText);
  }
  if (Object.keys(fragments).length == 0) {
    return null;
  }
  return fragments;
}
__name(parseDuration, "parseDuration");
function collectDateTimeFragment(fragments, match) {
  if (match[0].match(/^[a-zA-Z]+$/)) {
    return;
  }
  const num = parseNumberPattern(match[1]);
  const unit = TIME_UNIT_DICTIONARY[match[2].toLowerCase()];
  fragments[unit] = num;
}
__name(collectDateTimeFragment, "collectDateTimeFragment");

// node_modules/chrono-node/dist/esm/common/parsers/AbstractParserWithWordBoundary.js
var AbstractParserWithWordBoundaryChecking = class {
  static {
    __name(this, "AbstractParserWithWordBoundaryChecking");
  }
  innerPatternHasChange(context, currentInnerPattern) {
    return this.innerPattern(context) !== currentInnerPattern;
  }
  patternLeftBoundary() {
    return `(\\W|^)`;
  }
  cachedInnerPattern = null;
  cachedPattern = null;
  pattern(context) {
    if (this.cachedInnerPattern) {
      if (!this.innerPatternHasChange(context, this.cachedInnerPattern)) {
        return this.cachedPattern;
      }
    }
    this.cachedInnerPattern = this.innerPattern(context);
    this.cachedPattern = new RegExp(`${this.patternLeftBoundary()}${this.cachedInnerPattern.source}`, this.cachedInnerPattern.flags);
    return this.cachedPattern;
  }
  extract(context, match) {
    const header = match[1] ?? "";
    match.index = match.index + header.length;
    match[0] = match[0].substring(header.length);
    for (let i = 2; i < match.length; i++) {
      match[i - 1] = match[i];
    }
    return this.innerExtract(context, match);
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENTimeUnitWithinFormatParser.js
var PATTERN_WITH_OPTIONAL_PREFIX = new RegExp(`(?:(?:within|in|for)\\s*)?(?:(?:about|around|roughly|approximately|just)\\s*(?:~\\s*)?)?(${TIME_UNITS_PATTERN})(?=\\W|$)`, "i");
var PATTERN_WITH_PREFIX = new RegExp(`(?:within|in|for)\\s*(?:(?:about|around|roughly|approximately|just)\\s*(?:~\\s*)?)?(${TIME_UNITS_PATTERN})(?=\\W|$)`, "i");
var PATTERN_WITH_PREFIX_STRICT = new RegExp(`(?:within|in|for)\\s*(?:(?:about|around|roughly|approximately|just)\\s*(?:~\\s*)?)?(${TIME_UNITS_NO_ABBR_PATTERN})(?=\\W|$)`, "i");
var ENTimeUnitWithinFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENTimeUnitWithinFormatParser");
  }
  strictMode;
  constructor(strictMode) {
    super();
    this.strictMode = strictMode;
  }
  innerPattern(context) {
    if (this.strictMode) {
      return PATTERN_WITH_PREFIX_STRICT;
    }
    return context.option.forwardDate ? PATTERN_WITH_OPTIONAL_PREFIX : PATTERN_WITH_PREFIX;
  }
  innerExtract(context, match) {
    if (match[0].match(/^for\s*the\s*\w+/)) {
      return null;
    }
    const timeUnits = parseDuration(match[1]);
    if (!timeUnits) {
      return null;
    }
    return ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENMonthNameLittleEndianParser.js
var PATTERN = new RegExp(`(?:on\\s{0,3})?(${ORDINAL_NUMBER_PATTERN})(?:\\s{0,3}(?:to|\\-|\\\u2013|until|through|till)\\s{0,3}(${ORDINAL_NUMBER_PATTERN}))?(?:-|/|\\s{0,3}(?:of)?\\s{0,3})(${matchAnyPattern(MONTH_DICTIONARY)})(?:(?:-|/|,?\\s{0,3})(${YEAR_PATTERN}(?!\\w)))?(?=\\W|$)`, "i");
var DATE_GROUP = 1;
var DATE_TO_GROUP = 2;
var MONTH_NAME_GROUP = 3;
var YEAR_GROUP = 4;
var ENMonthNameLittleEndianParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENMonthNameLittleEndianParser");
  }
  innerPattern() {
    return PATTERN;
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    const month = MONTH_DICTIONARY[match[MONTH_NAME_GROUP].toLowerCase()];
    const day = parseOrdinalNumberPattern(match[DATE_GROUP]);
    if (day > 31) {
      match.index = match.index + match[DATE_GROUP].length;
      return null;
    }
    result.start.assign("month", month);
    result.start.assign("day", day);
    if (match[YEAR_GROUP]) {
      const yearNumber = parseYear(match[YEAR_GROUP]);
      result.start.assign("year", yearNumber);
    } else {
      const year = findYearClosestToRef(context.refDate, day, month);
      result.start.imply("year", year);
    }
    if (match[DATE_TO_GROUP]) {
      const endDate = parseOrdinalNumberPattern(match[DATE_TO_GROUP]);
      result.end = result.start.clone();
      result.end.assign("day", endDate);
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENMonthNameMiddleEndianParser.js
var PATTERN2 = new RegExp(`(${matchAnyPattern(MONTH_DICTIONARY)})(?:-|/|\\s*,?\\s*)(${ORDINAL_NUMBER_PATTERN})(?!\\s*(?:am|pm))\\s*(?:(?:to|\\-)\\s*(${ORDINAL_NUMBER_PATTERN})\\s*)?(?:(?:-|/|\\s*,\\s*|\\s+)(${YEAR_PATTERN}))?(?=\\W|$)(?!\\:\\d)`, "i");
var MONTH_NAME_GROUP2 = 1;
var DATE_GROUP2 = 2;
var DATE_TO_GROUP2 = 3;
var YEAR_GROUP2 = 4;
var ENMonthNameMiddleEndianParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENMonthNameMiddleEndianParser");
  }
  shouldSkipYearLikeDate;
  constructor(shouldSkipYearLikeDate) {
    super();
    this.shouldSkipYearLikeDate = shouldSkipYearLikeDate;
  }
  innerPattern() {
    return PATTERN2;
  }
  innerExtract(context, match) {
    const month = MONTH_DICTIONARY[match[MONTH_NAME_GROUP2].toLowerCase()];
    const day = parseOrdinalNumberPattern(match[DATE_GROUP2]);
    if (day > 31) {
      return null;
    }
    if (this.shouldSkipYearLikeDate) {
      if (!match[DATE_TO_GROUP2] && !match[YEAR_GROUP2] && match[DATE_GROUP2].match(/^\d{2}$/)) {
        return null;
      }
    }
    const components = context.createParsingComponents({
      day,
      month
    }).addTag("parser/ENMonthNameMiddleEndianParser");
    if (match[YEAR_GROUP2]) {
      const year = parseYear(match[YEAR_GROUP2]);
      components.assign("year", year);
    } else {
      const year = findYearClosestToRef(context.refDate, day, month);
      components.imply("year", year);
    }
    if (!match[DATE_TO_GROUP2]) {
      return components;
    }
    const endDate = parseOrdinalNumberPattern(match[DATE_TO_GROUP2]);
    const result = context.createParsingResult(match.index, match[0]);
    result.start = components;
    result.end = components.clone();
    result.end.assign("day", endDate);
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENMonthNameParser.js
var PATTERN3 = new RegExp(`((?:in)\\s*)?(${matchAnyPattern(MONTH_DICTIONARY)})\\s*(?:(?:,|-|of)?\\s*(${YEAR_PATTERN})?)?(?=[^\\s\\w]|\\s+[^0-9]|\\s+$|$)`, "i");
var PREFIX_GROUP = 1;
var MONTH_NAME_GROUP3 = 2;
var YEAR_GROUP3 = 3;
var ENMonthNameParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENMonthNameParser");
  }
  innerPattern() {
    return PATTERN3;
  }
  innerExtract(context, match) {
    const monthName = match[MONTH_NAME_GROUP3].toLowerCase();
    if (match[0].length <= 3 && !FULL_MONTH_NAME_DICTIONARY[monthName]) {
      return null;
    }
    const result = context.createParsingResult(match.index + (match[PREFIX_GROUP] || "").length, match.index + match[0].length);
    result.start.imply("day", 1);
    result.start.addTag("parser/ENMonthNameParser");
    const month = MONTH_DICTIONARY[monthName];
    result.start.assign("month", month);
    if (match[YEAR_GROUP3]) {
      const year = parseYear(match[YEAR_GROUP3]);
      result.start.assign("year", year);
    } else {
      const year = findYearClosestToRef(context.refDate, 1, month);
      result.start.imply("year", year);
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENYearMonthDayParser.js
var PATTERN4 = new RegExp(`([0-9]{4})[-\\.\\/\\s](?:(${matchAnyPattern(MONTH_DICTIONARY)})|([0-9]{1,2}))[-\\.\\/\\s]([0-9]{1,2})(?=\\W|$)`, "i");
var YEAR_NUMBER_GROUP = 1;
var MONTH_NAME_GROUP4 = 2;
var MONTH_NUMBER_GROUP = 3;
var DATE_NUMBER_GROUP = 4;
var ENYearMonthDayParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENYearMonthDayParser");
  }
  strictMonthDateOrder;
  constructor(strictMonthDateOrder) {
    super();
    this.strictMonthDateOrder = strictMonthDateOrder;
  }
  innerPattern() {
    return PATTERN4;
  }
  innerExtract(context, match) {
    const year = parseInt(match[YEAR_NUMBER_GROUP]);
    let day = parseInt(match[DATE_NUMBER_GROUP]);
    let month = match[MONTH_NUMBER_GROUP] ? parseInt(match[MONTH_NUMBER_GROUP]) : MONTH_DICTIONARY[match[MONTH_NAME_GROUP4].toLowerCase()];
    if (month < 1 || month > 12) {
      if (this.strictMonthDateOrder) {
        return null;
      }
      if (day >= 1 && day <= 12) {
        [month, day] = [day, month];
      }
    }
    if (day < 1 || day > 31) {
      return null;
    }
    return {
      day,
      month,
      year
    };
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENYearMonthNameParser.js
var YEAR_PATTERN2 = `(?:[1-9][0-9]{0,3}\\s{0,2}(?:BE|AD|BC|BCE|CE)|[1-9][0-9]{3})`;
var PATTERN5 = new RegExp(`(${YEAR_PATTERN2})(?:\\s*[-.\\/,]?\\s*|\\s+of\\s+)(${matchAnyPattern(MONTH_DICTIONARY)})(?=[^\\s\\w]|\\s+[^0-9]|\\s+$|$)`, "i");
var YEAR_GROUP4 = 1;
var MONTH_NAME_GROUP5 = 2;
var ENYearMonthNameParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENYearMonthNameParser");
  }
  innerPattern() {
    return PATTERN5;
  }
  innerExtract(context, match) {
    const year = parseYear(match[YEAR_GROUP4]);
    const monthName = match[MONTH_NAME_GROUP5].toLowerCase();
    const month = MONTH_DICTIONARY[monthName];
    const result = context.createParsingResult(match.index, match[0]);
    result.start.imply("day", 1);
    result.start.assign("month", month);
    result.start.assign("year", year);
    result.start.addTag("parser/ENYearMonthNameParser");
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENSlashMonthFormatParser.js
var PATTERN6 = new RegExp("([0-9]|0[1-9]|1[012])/([0-9]{4})", "i");
var MONTH_GROUP = 1;
var YEAR_GROUP5 = 2;
var ENSlashMonthFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENSlashMonthFormatParser");
  }
  innerPattern() {
    return PATTERN6;
  }
  innerExtract(context, match) {
    const year = parseInt(match[YEAR_GROUP5]);
    const month = parseInt(match[MONTH_GROUP]);
    return context.createParsingComponents().imply("day", 1).assign("month", month).assign("year", year);
  }
};

// node_modules/chrono-node/dist/esm/common/parsers/AbstractTimeExpressionParser.js
function primaryTimePattern(leftBoundary, primaryPrefix, primarySuffix, flags) {
  return new RegExp(`${leftBoundary}${primaryPrefix}(\\d{1,4})(?:(?:\\.|:|\uFF1A)(\\d{1,2})(?:(?::|\uFF1A)(\\d{2})(?:\\.(\\d{1,6}))?)?)?(?:\\s*(a\\.m\\.|p\\.m\\.|am?|pm?))?${primarySuffix}`, flags);
}
__name(primaryTimePattern, "primaryTimePattern");
function followingTimePatten(followingPhase, followingSuffix) {
  return new RegExp(`^(${followingPhase})(\\d{1,4})(?:(?:\\.|\\:|\\\uFF1A)(\\d{1,2})(?:(?:\\.|\\:|\\\uFF1A)(\\d{1,2})(?:\\.(\\d{1,6}))?)?)?(?:\\s*(a\\.m\\.|p\\.m\\.|am?|pm?))?${followingSuffix}`, "i");
}
__name(followingTimePatten, "followingTimePatten");
var HOUR_GROUP = 2;
var MINUTE_GROUP = 3;
var SECOND_GROUP = 4;
var MILLI_SECOND_GROUP = 5;
var AM_PM_HOUR_GROUP = 6;
var AbstractTimeExpressionParser = class {
  static {
    __name(this, "AbstractTimeExpressionParser");
  }
  strictMode;
  constructor(strictMode = false) {
    this.strictMode = strictMode;
  }
  patternFlags() {
    return "i";
  }
  primaryPatternLeftBoundary() {
    return `(^|\\s|T|\\b)`;
  }
  primarySuffix() {
    return `(?!/)(?=\\W|$)`;
  }
  followingSuffix() {
    return `(?!/)(?=\\W|$)`;
  }
  pattern(context) {
    return this.getPrimaryTimePatternThroughCache();
  }
  extract(context, match) {
    const startComponents = this.extractPrimaryTimeComponents(context, match);
    if (!startComponents) {
      if (match[0].match(/^\d{4}/)) {
        match.index += 4;
        return null;
      }
      match.index += match[0].length;
      return null;
    }
    const index = match.index + match[1].length;
    const text2 = match[0].substring(match[1].length);
    const result = context.createParsingResult(index, text2, startComponents);
    match.index += match[0].length;
    const remainingText = context.text.substring(match.index);
    const followingPattern = this.getFollowingTimePatternThroughCache();
    const followingMatch = followingPattern.exec(remainingText);
    if (text2.match(/^\d{3,4}/) && followingMatch) {
      if (followingMatch[0].match(/^\s*([+-])\s*\d{2,4}$/)) {
        return null;
      }
      if (followingMatch[0].match(/^\s*([+-])\s*\d{2}\W\d{2}/)) {
        return null;
      }
    }
    if (!followingMatch || followingMatch[0].match(/^\s*([+-])\s*\d{3,4}$/)) {
      return this.checkAndReturnWithoutFollowingPattern(result);
    }
    result.end = this.extractFollowingTimeComponents(context, followingMatch, result);
    if (result.end) {
      result.text += followingMatch[0];
    }
    return this.checkAndReturnWithFollowingPattern(result);
  }
  extractPrimaryTimeComponents(context, match, strict4 = false) {
    const components = context.createParsingComponents();
    let minute = 0;
    let meridiem = null;
    let hour = parseInt(match[HOUR_GROUP]);
    if (hour > 100) {
      if (match[HOUR_GROUP].length == 4 && match[MINUTE_GROUP] == null && !match[AM_PM_HOUR_GROUP]) {
        return null;
      }
      if (this.strictMode || match[MINUTE_GROUP] != null) {
        return null;
      }
      minute = hour % 100;
      hour = Math.floor(hour / 100);
    }
    if (hour > 24) {
      return null;
    }
    if (match[MINUTE_GROUP] != null) {
      if (match[MINUTE_GROUP].length == 1 && !match[AM_PM_HOUR_GROUP]) {
        return null;
      }
      minute = parseInt(match[MINUTE_GROUP]);
    }
    if (minute >= 60) {
      return null;
    }
    if (hour > 12) {
      meridiem = Meridiem.PM;
    }
    if (match[AM_PM_HOUR_GROUP] != null) {
      if (hour > 12)
        return null;
      const ampm = match[AM_PM_HOUR_GROUP][0].toLowerCase();
      if (ampm == "a") {
        meridiem = Meridiem.AM;
        if (hour == 12) {
          hour = 0;
        }
      }
      if (ampm == "p") {
        meridiem = Meridiem.PM;
        if (hour != 12) {
          hour += 12;
        }
      }
    }
    components.assign("hour", hour);
    components.assign("minute", minute);
    if (meridiem !== null) {
      components.assign("meridiem", meridiem);
    } else {
      if (hour < 12) {
        components.imply("meridiem", Meridiem.AM);
      } else {
        components.imply("meridiem", Meridiem.PM);
      }
    }
    if (match[MILLI_SECOND_GROUP] != null) {
      const millisecond = parseInt(match[MILLI_SECOND_GROUP].substring(0, 3));
      if (millisecond >= 1e3)
        return null;
      components.assign("millisecond", millisecond);
    }
    if (match[SECOND_GROUP] != null) {
      const second = parseInt(match[SECOND_GROUP]);
      if (second >= 60)
        return null;
      components.assign("second", second);
    }
    return components;
  }
  extractFollowingTimeComponents(context, match, result) {
    const components = context.createParsingComponents();
    if (match[MILLI_SECOND_GROUP] != null) {
      const millisecond = parseInt(match[MILLI_SECOND_GROUP].substring(0, 3));
      if (millisecond >= 1e3)
        return null;
      components.assign("millisecond", millisecond);
    }
    if (match[SECOND_GROUP] != null) {
      const second = parseInt(match[SECOND_GROUP]);
      if (second >= 60)
        return null;
      components.assign("second", second);
    }
    let hour = parseInt(match[HOUR_GROUP]);
    let minute = 0;
    let meridiem = -1;
    if (match[MINUTE_GROUP] != null) {
      minute = parseInt(match[MINUTE_GROUP]);
    } else if (hour > 100) {
      minute = hour % 100;
      hour = Math.floor(hour / 100);
    }
    if (minute >= 60 || hour > 24) {
      return null;
    }
    if (hour >= 12) {
      meridiem = Meridiem.PM;
    }
    if (match[AM_PM_HOUR_GROUP] != null) {
      if (hour > 12) {
        return null;
      }
      const ampm = match[AM_PM_HOUR_GROUP][0].toLowerCase();
      if (ampm == "a") {
        meridiem = Meridiem.AM;
        if (hour == 12) {
          hour = 0;
          if (!components.isCertain("day")) {
            components.imply("day", components.get("day") + 1);
          }
        }
      }
      if (ampm == "p") {
        meridiem = Meridiem.PM;
        if (hour != 12)
          hour += 12;
      }
      if (!result.start.isCertain("meridiem")) {
        if (meridiem == Meridiem.AM) {
          result.start.imply("meridiem", Meridiem.AM);
          if (result.start.get("hour") == 12) {
            result.start.assign("hour", 0);
          }
        } else {
          result.start.imply("meridiem", Meridiem.PM);
          if (result.start.get("hour") != 12) {
            result.start.assign("hour", result.start.get("hour") + 12);
          }
        }
      }
    }
    components.assign("hour", hour);
    components.assign("minute", minute);
    if (meridiem >= 0) {
      components.assign("meridiem", meridiem);
    } else {
      const startAtPM = result.start.isCertain("meridiem") && result.start.get("hour") > 12;
      if (startAtPM) {
        if (result.start.get("hour") - 12 > hour) {
          components.imply("meridiem", Meridiem.AM);
        } else if (hour <= 12) {
          components.assign("hour", hour + 12);
          components.assign("meridiem", Meridiem.PM);
        }
      } else if (hour > 12) {
        components.imply("meridiem", Meridiem.PM);
      } else if (hour <= 12) {
        components.imply("meridiem", Meridiem.AM);
      }
    }
    if (components.date().getTime() < result.start.date().getTime()) {
      components.imply("day", components.get("day") + 1);
    }
    return components;
  }
  checkAndReturnWithoutFollowingPattern(result) {
    if (result.text.match(/^\d$/)) {
      return null;
    }
    if (result.text.match(/^\d\d\d+$/)) {
      return null;
    }
    if (result.text.match(/\d[apAP]$/)) {
      return null;
    }
    const endingWithNumbers = result.text.match(/[^\d:.](\d[\d.]+)$/);
    if (endingWithNumbers) {
      const endingNumbers = endingWithNumbers[1];
      if (this.strictMode) {
        return null;
      }
      if (endingNumbers.includes(".") && !endingNumbers.match(/\d(\.\d{2})+$/)) {
        return null;
      }
      const endingNumberVal = parseInt(endingNumbers);
      if (endingNumberVal > 24) {
        return null;
      }
    }
    return result;
  }
  checkAndReturnWithFollowingPattern(result) {
    if (result.text.match(/^\d+-\d+$/)) {
      return null;
    }
    const endingWithNumbers = result.text.match(/[^\d:.](\d[\d.]+)\s*-\s*(\d[\d.]+)$/);
    if (endingWithNumbers) {
      if (this.strictMode) {
        return null;
      }
      const startingNumbers = endingWithNumbers[1];
      const endingNumbers = endingWithNumbers[2];
      if (endingNumbers.includes(".") && !endingNumbers.match(/\d(\.\d{2})+$/)) {
        return null;
      }
      const endingNumberVal = parseInt(endingNumbers);
      const startingNumberVal = parseInt(startingNumbers);
      if (endingNumberVal > 24 || startingNumberVal > 24) {
        return null;
      }
    }
    return result;
  }
  cachedPrimaryPrefix = null;
  cachedPrimarySuffix = null;
  cachedPrimaryTimePattern = null;
  getPrimaryTimePatternThroughCache() {
    const primaryPrefix = this.primaryPrefix();
    const primarySuffix = this.primarySuffix();
    if (this.cachedPrimaryPrefix === primaryPrefix && this.cachedPrimarySuffix === primarySuffix) {
      return this.cachedPrimaryTimePattern;
    }
    this.cachedPrimaryTimePattern = primaryTimePattern(this.primaryPatternLeftBoundary(), primaryPrefix, primarySuffix, this.patternFlags());
    this.cachedPrimaryPrefix = primaryPrefix;
    this.cachedPrimarySuffix = primarySuffix;
    return this.cachedPrimaryTimePattern;
  }
  cachedFollowingPhase = null;
  cachedFollowingSuffix = null;
  cachedFollowingTimePatten = null;
  getFollowingTimePatternThroughCache() {
    const followingPhase = this.followingPhase();
    const followingSuffix = this.followingSuffix();
    if (this.cachedFollowingPhase === followingPhase && this.cachedFollowingSuffix === followingSuffix) {
      return this.cachedFollowingTimePatten;
    }
    this.cachedFollowingTimePatten = followingTimePatten(followingPhase, followingSuffix);
    this.cachedFollowingPhase = followingPhase;
    this.cachedFollowingSuffix = followingSuffix;
    return this.cachedFollowingTimePatten;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENTimeExpressionParser.js
var ENTimeExpressionParser = class extends AbstractTimeExpressionParser {
  static {
    __name(this, "ENTimeExpressionParser");
  }
  constructor(strictMode) {
    super(strictMode);
  }
  followingPhase() {
    return "\\s*(?:\\-|\\\u2013|\\~|\\\u301C|to|until|through|till|\\?)\\s*";
  }
  primaryPrefix() {
    return "(?:(?:at|from)\\s*)??";
  }
  primarySuffix() {
    return "(?:\\s*(?:o\\W*clock|at\\s*night|in\\s*the\\s*(?:morning|afternoon)))?(?!/)(?=\\W|$)";
  }
  extractPrimaryTimeComponents(context, match) {
    const components = super.extractPrimaryTimeComponents(context, match);
    if (!components) {
      return components;
    }
    if (match[0].endsWith("night")) {
      const hour = components.get("hour");
      if (hour >= 6 && hour < 12) {
        components.assign("hour", components.get("hour") + 12);
        components.assign("meridiem", Meridiem.PM);
      } else if (hour < 6) {
        components.assign("meridiem", Meridiem.AM);
      }
    }
    if (match[0].endsWith("afternoon")) {
      components.assign("meridiem", Meridiem.PM);
      const hour = components.get("hour");
      if (hour >= 0 && hour <= 6) {
        components.assign("hour", components.get("hour") + 12);
      }
    }
    if (match[0].endsWith("morning")) {
      components.assign("meridiem", Meridiem.AM);
      const hour = components.get("hour");
      if (hour < 12) {
        components.assign("hour", components.get("hour"));
      }
    }
    return components.addTag("parser/ENTimeExpressionParser");
  }
  extractFollowingTimeComponents(context, match, result) {
    const followingComponents = super.extractFollowingTimeComponents(context, match, result);
    if (followingComponents) {
      followingComponents.addTag("parser/ENTimeExpressionParser");
    }
    return followingComponents;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENTimeUnitAgoFormatParser.js
var PATTERN7 = new RegExp(`(${TIME_UNITS_PATTERN})\\s{0,5}(?:ago|before|earlier)(?=\\W|$)`, "i");
var STRICT_PATTERN = new RegExp(`(${TIME_UNITS_NO_ABBR_PATTERN})\\s{0,5}(?:ago|before|earlier)(?=\\W|$)`, "i");
var ENTimeUnitAgoFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENTimeUnitAgoFormatParser");
  }
  strictMode;
  constructor(strictMode) {
    super();
    this.strictMode = strictMode;
  }
  innerPattern() {
    return this.strictMode ? STRICT_PATTERN : PATTERN7;
  }
  innerExtract(context, match) {
    const duration = parseDuration(match[1]);
    if (!duration) {
      return null;
    }
    return ParsingComponents.createRelativeFromReference(context.reference, reverseDuration(duration));
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENTimeUnitLaterFormatParser.js
var PATTERN8 = new RegExp(`(${TIME_UNITS_PATTERN})\\s{0,5}(?:later|after|from now|henceforth|forward|out)(?=(?:\\W|$))`, "i");
var STRICT_PATTERN2 = new RegExp(`(${TIME_UNITS_NO_ABBR_PATTERN})\\s{0,5}(later|after|from now)(?=\\W|$)`, "i");
var GROUP_NUM_TIMEUNITS = 1;
var ENTimeUnitLaterFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENTimeUnitLaterFormatParser");
  }
  strictMode;
  constructor(strictMode) {
    super();
    this.strictMode = strictMode;
  }
  innerPattern() {
    return this.strictMode ? STRICT_PATTERN2 : PATTERN8;
  }
  innerExtract(context, match) {
    const timeUnits = parseDuration(match[GROUP_NUM_TIMEUNITS]);
    if (!timeUnits) {
      return null;
    }
    return ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
  }
};

// node_modules/chrono-node/dist/esm/common/abstractRefiners.js
var Filter = class {
  static {
    __name(this, "Filter");
  }
  refine(context, results) {
    return results.filter((r) => this.isValid(context, r));
  }
};
var MergingRefiner = class {
  static {
    __name(this, "MergingRefiner");
  }
  refine(context, results) {
    if (results.length < 2) {
      return results;
    }
    const mergedResults = [];
    let curResult = results[0];
    let nextResult = null;
    for (let i = 1; i < results.length; i++) {
      nextResult = results[i];
      const textBetween = context.text.substring(curResult.index + curResult.text.length, nextResult.index);
      if (!this.shouldMergeResults(textBetween, curResult, nextResult, context)) {
        mergedResults.push(curResult);
        curResult = nextResult;
      } else {
        const left = curResult;
        const right = nextResult;
        const mergedResult = this.mergeResults(textBetween, left, right, context);
        context.debug(() => {
          console.log(`${this.constructor.name} merged ${left} and ${right} into ${mergedResult}`);
        });
        curResult = mergedResult;
      }
    }
    if (curResult != null) {
      mergedResults.push(curResult);
    }
    return mergedResults;
  }
};

// node_modules/chrono-node/dist/esm/common/refiners/AbstractMergeDateRangeRefiner.js
var AbstractMergeDateRangeRefiner = class extends MergingRefiner {
  static {
    __name(this, "AbstractMergeDateRangeRefiner");
  }
  shouldMergeResults(textBetween, currentResult, nextResult) {
    return !currentResult.end && !nextResult.end && textBetween.match(this.patternBetween()) != null;
  }
  mergeResults(textBetween, fromResult, toResult) {
    if (!fromResult.start.isOnlyWeekdayComponent() && !toResult.start.isOnlyWeekdayComponent()) {
      toResult.start.getCertainComponents().forEach((key) => {
        if (!fromResult.start.isCertain(key)) {
          fromResult.start.imply(key, toResult.start.get(key));
        }
      });
      fromResult.start.getCertainComponents().forEach((key) => {
        if (!toResult.start.isCertain(key)) {
          toResult.start.imply(key, fromResult.start.get(key));
        }
      });
    }
    if (fromResult.start.date() > toResult.start.date()) {
      let fromDate = fromResult.start.date();
      let toDate = toResult.start.date();
      if (toResult.start.isOnlyWeekdayComponent() && addDuration(toDate, { day: 7 }) > fromDate) {
        toDate = addDuration(toDate, { day: 7 });
        toResult.start.imply("day", toDate.getDate());
        toResult.start.imply("month", toDate.getMonth() + 1);
        toResult.start.imply("year", toDate.getFullYear());
      } else if (fromResult.start.isOnlyWeekdayComponent() && addDuration(fromDate, { day: -7 }) < toDate) {
        fromDate = addDuration(fromDate, { day: -7 });
        fromResult.start.imply("day", fromDate.getDate());
        fromResult.start.imply("month", fromDate.getMonth() + 1);
        fromResult.start.imply("year", fromDate.getFullYear());
      } else if (toResult.start.isDateWithUnknownYear() && addDuration(toDate, { year: 1 }) > fromDate) {
        toDate = addDuration(toDate, { year: 1 });
        toResult.start.imply("year", toDate.getFullYear());
      } else if (fromResult.start.isDateWithUnknownYear() && addDuration(fromDate, { year: -1 }) < toDate) {
        fromDate = addDuration(fromDate, { year: -1 });
        fromResult.start.imply("year", fromDate.getFullYear());
      } else {
        [toResult, fromResult] = [fromResult, toResult];
      }
    }
    const result = fromResult.clone();
    result.start = fromResult.start;
    result.end = toResult.start;
    result.index = Math.min(fromResult.index, toResult.index);
    if (fromResult.index < toResult.index) {
      result.text = fromResult.text + textBetween + toResult.text;
    } else {
      result.text = toResult.text + textBetween + fromResult.text;
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/refiners/ENMergeDateRangeRefiner.js
var ENMergeDateRangeRefiner = class extends AbstractMergeDateRangeRefiner {
  static {
    __name(this, "ENMergeDateRangeRefiner");
  }
  patternBetween() {
    return /^\s*(to|-|–|until|through|till)\s*$/i;
  }
};

// node_modules/chrono-node/dist/esm/calculation/mergingCalculation.js
function mergeDateTimeResult(dateResult, timeResult) {
  const result = dateResult.clone();
  const beginDate = dateResult.start;
  const beginTime = timeResult.start;
  result.start = mergeDateTimeComponent(beginDate, beginTime);
  if (dateResult.end != null || timeResult.end != null) {
    const endDate = dateResult.end == null ? dateResult.start : dateResult.end;
    const endTime = timeResult.end == null ? timeResult.start : timeResult.end;
    const endDateTime = mergeDateTimeComponent(endDate, endTime);
    if (dateResult.end == null && endDateTime.date().getTime() < result.start.date().getTime()) {
      const nextDay = new Date(endDateTime.date().getTime());
      nextDay.setDate(nextDay.getDate() + 1);
      if (endDateTime.isCertain("day")) {
        assignSimilarDate(endDateTime, nextDay);
      } else {
        implySimilarDate(endDateTime, nextDay);
      }
    }
    result.end = endDateTime;
  }
  return result;
}
__name(mergeDateTimeResult, "mergeDateTimeResult");
function mergeDateTimeComponent(dateComponent, timeComponent) {
  const dateTimeComponent = dateComponent.clone();
  if (timeComponent.isCertain("hour")) {
    dateTimeComponent.assign("hour", timeComponent.get("hour"));
    dateTimeComponent.assign("minute", timeComponent.get("minute"));
    if (timeComponent.isCertain("second")) {
      dateTimeComponent.assign("second", timeComponent.get("second"));
      if (timeComponent.isCertain("millisecond")) {
        dateTimeComponent.assign("millisecond", timeComponent.get("millisecond"));
      } else {
        dateTimeComponent.imply("millisecond", timeComponent.get("millisecond"));
      }
    } else {
      dateTimeComponent.imply("second", timeComponent.get("second"));
      dateTimeComponent.imply("millisecond", timeComponent.get("millisecond"));
    }
  } else {
    dateTimeComponent.imply("hour", timeComponent.get("hour"));
    dateTimeComponent.imply("minute", timeComponent.get("minute"));
    dateTimeComponent.imply("second", timeComponent.get("second"));
    dateTimeComponent.imply("millisecond", timeComponent.get("millisecond"));
  }
  if (timeComponent.isCertain("timezoneOffset")) {
    dateTimeComponent.assign("timezoneOffset", timeComponent.get("timezoneOffset"));
  }
  const dateHasMeaningfulMeridiem = dateComponent.get("meridiem") != null && (dateComponent.isCertain("meridiem") || Array.from(dateComponent.tags()).some((t) => t.startsWith("casualReference/")));
  if (timeComponent.isCertain("meridiem")) {
    dateTimeComponent.assign("meridiem", timeComponent.get("meridiem"));
  } else if (timeComponent.get("meridiem") != null && !dateHasMeaningfulMeridiem) {
    dateTimeComponent.imply("meridiem", timeComponent.get("meridiem"));
  }
  if (dateTimeComponent.get("meridiem") == Meridiem.PM && dateTimeComponent.get("hour") < 12) {
    if (timeComponent.isCertain("hour")) {
      dateTimeComponent.assign("hour", dateTimeComponent.get("hour") + 12);
    } else {
      dateTimeComponent.imply("hour", dateTimeComponent.get("hour") + 12);
    }
  }
  dateTimeComponent.addTags(dateComponent.tags());
  dateTimeComponent.addTags(timeComponent.tags());
  return dateTimeComponent;
}
__name(mergeDateTimeComponent, "mergeDateTimeComponent");

// node_modules/chrono-node/dist/esm/common/refiners/AbstractMergeDateTimeRefiner.js
var AbstractMergeDateTimeRefiner = class extends MergingRefiner {
  static {
    __name(this, "AbstractMergeDateTimeRefiner");
  }
  shouldMergeResults(textBetween, currentResult, nextResult) {
    return (currentResult.start.isOnlyDate() && nextResult.start.isOnlyTime() || nextResult.start.isOnlyDate() && currentResult.start.isOnlyTime()) && textBetween.match(this.patternBetween()) != null;
  }
  mergeResults(textBetween, currentResult, nextResult) {
    const result = currentResult.start.isOnlyDate() ? mergeDateTimeResult(currentResult, nextResult) : mergeDateTimeResult(nextResult, currentResult);
    result.index = currentResult.index;
    result.text = currentResult.text + textBetween + nextResult.text;
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/refiners/ENMergeDateTimeRefiner.js
var ENMergeDateTimeRefiner = class extends AbstractMergeDateTimeRefiner {
  static {
    __name(this, "ENMergeDateTimeRefiner");
  }
  patternBetween() {
    return new RegExp("^\\s*(T|at|after|before|on|of|,|-|\\.|\u2219|:)?\\s*$");
  }
};

// node_modules/chrono-node/dist/esm/common/refiners/ExtractTimezoneAbbrRefiner.js
var TIMEZONE_NAME_PATTERN = new RegExp("^\\s*,?\\s*\\(?([A-Z]{2,4})\\)?(?=\\W|$)", "i");
var ExtractTimezoneAbbrRefiner = class {
  static {
    __name(this, "ExtractTimezoneAbbrRefiner");
  }
  timezoneOverrides;
  constructor(timezoneOverrides) {
    this.timezoneOverrides = timezoneOverrides;
  }
  refine(context, results) {
    const timezoneOverrides = context.option.timezones ?? {};
    results.forEach((result) => {
      const suffix = context.text.substring(result.index + result.text.length);
      const match = TIMEZONE_NAME_PATTERN.exec(suffix);
      if (!match) {
        return;
      }
      const timezoneAbbr = match[1].toUpperCase();
      const refDate = result.start.date() ?? result.refDate ?? /* @__PURE__ */ new Date();
      const tzOverrides = { ...this.timezoneOverrides, ...timezoneOverrides };
      const extractedTimezoneOffset = toTimezoneOffset(timezoneAbbr, refDate, tzOverrides);
      if (extractedTimezoneOffset == null) {
        return;
      }
      context.debug(() => {
        console.log(`Extracting timezone: '${timezoneAbbr}' into: ${extractedTimezoneOffset} for: ${result.start}`);
      });
      const currentTimezoneOffset = result.start.get("timezoneOffset");
      if (currentTimezoneOffset !== null && extractedTimezoneOffset != currentTimezoneOffset) {
        if (result.start.isCertain("timezoneOffset")) {
          return;
        }
        if (timezoneAbbr != match[1]) {
          return;
        }
      }
      if (result.start.isOnlyDate()) {
        if (timezoneAbbr != match[1]) {
          return;
        }
      }
      result.text += match[0];
      if (!result.start.isCertain("timezoneOffset")) {
        result.start.assign("timezoneOffset", extractedTimezoneOffset);
      }
      if (result.end != null && !result.end.isCertain("timezoneOffset")) {
        result.end.assign("timezoneOffset", extractedTimezoneOffset);
      }
    });
    return results;
  }
};

// node_modules/chrono-node/dist/esm/common/refiners/ExtractTimezoneOffsetRefiner.js
var TIMEZONE_OFFSET_PATTERN = new RegExp("^\\s*(?:\\(?(?:GMT|UTC)\\s?)?([+-])(\\d{1,2})(?::?(\\d{2}))?\\)?", "i");
var TIMEZONE_OFFSET_SIGN_GROUP = 1;
var TIMEZONE_OFFSET_HOUR_OFFSET_GROUP = 2;
var TIMEZONE_OFFSET_MINUTE_OFFSET_GROUP = 3;
var ExtractTimezoneOffsetRefiner = class {
  static {
    __name(this, "ExtractTimezoneOffsetRefiner");
  }
  refine(context, results) {
    results.forEach(function(result) {
      if (result.start.isCertain("timezoneOffset")) {
        return;
      }
      const suffix = context.text.substring(result.index + result.text.length);
      const match = TIMEZONE_OFFSET_PATTERN.exec(suffix);
      if (!match) {
        return;
      }
      context.debug(() => {
        console.log(`Extracting timezone: '${match[0]}' into : ${result}`);
      });
      const hourOffset = parseInt(match[TIMEZONE_OFFSET_HOUR_OFFSET_GROUP]);
      const minuteOffset = parseInt(match[TIMEZONE_OFFSET_MINUTE_OFFSET_GROUP] || "0");
      let timezoneOffset = hourOffset * 60 + minuteOffset;
      if (timezoneOffset > 14 * 60) {
        return;
      }
      if (match[TIMEZONE_OFFSET_SIGN_GROUP] === "-") {
        timezoneOffset = -timezoneOffset;
      }
      if (result.end != null) {
        result.end.assign("timezoneOffset", timezoneOffset);
      }
      result.start.assign("timezoneOffset", timezoneOffset);
      result.text += match[0];
    });
    return results;
  }
};

// node_modules/chrono-node/dist/esm/common/refiners/OverlapRemovalRefiner.js
var OverlapRemovalRefiner = class {
  static {
    __name(this, "OverlapRemovalRefiner");
  }
  refine(context, results) {
    if (results.length < 2) {
      return results;
    }
    const filteredResults = [];
    let prevResult = results[0];
    for (let i = 1; i < results.length; i++) {
      const result = results[i];
      if (result.index >= prevResult.index + prevResult.text.length) {
        filteredResults.push(prevResult);
        prevResult = result;
        continue;
      }
      let kept = null;
      let removed = null;
      if (result.text.length > prevResult.text.length) {
        kept = result;
        removed = prevResult;
      } else {
        kept = prevResult;
        removed = result;
      }
      context.debug(() => {
        console.log(`${this.constructor.name} remove ${removed} by ${kept}`);
      });
      prevResult = kept;
    }
    if (prevResult != null) {
      filteredResults.push(prevResult);
    }
    return filteredResults;
  }
};

// node_modules/chrono-node/dist/esm/calculation/weekdays.js
function createParsingComponentsAtWeekday(reference, weekday, modifier) {
  const refDate = reference.getDateWithAdjustedTimezone();
  const daysToWeekday = getDaysToWeekday(refDate, weekday, modifier);
  let components = new ParsingComponents(reference);
  components = components.addDurationAsImplied({ day: daysToWeekday });
  components.assign("weekday", weekday);
  return components;
}
__name(createParsingComponentsAtWeekday, "createParsingComponentsAtWeekday");
function getDaysToWeekday(refDate, weekday, modifier) {
  const refWeekday = refDate.getDay();
  switch (modifier) {
    case "this":
      return getDaysForwardToWeekday(refDate, weekday);
    case "last":
      return getBackwardDaysToWeekday(refDate, weekday);
    case "next":
      if (refWeekday == Weekday.SUNDAY) {
        return weekday == Weekday.SUNDAY ? 7 : weekday;
      }
      if (refWeekday == Weekday.SATURDAY) {
        if (weekday == Weekday.SATURDAY)
          return 7;
        if (weekday == Weekday.SUNDAY)
          return 8;
        return 1 + weekday;
      }
      if (weekday < refWeekday && weekday != Weekday.SUNDAY) {
        return getDaysForwardToWeekday(refDate, weekday);
      } else {
        return getDaysForwardToWeekday(refDate, weekday) + 7;
      }
  }
  return getDaysToWeekdayClosest(refDate, weekday);
}
__name(getDaysToWeekday, "getDaysToWeekday");
function getDaysToWeekdayClosest(refDate, weekday) {
  const backward = getBackwardDaysToWeekday(refDate, weekday);
  const forward = getDaysForwardToWeekday(refDate, weekday);
  return forward < -backward ? forward : backward;
}
__name(getDaysToWeekdayClosest, "getDaysToWeekdayClosest");
function getDaysForwardToWeekday(refDate, weekday) {
  const refWeekday = refDate.getDay();
  let forwardCount = weekday - refWeekday;
  if (forwardCount < 0) {
    forwardCount += 7;
  }
  return forwardCount;
}
__name(getDaysForwardToWeekday, "getDaysForwardToWeekday");
function getBackwardDaysToWeekday(refDate, weekday) {
  const refWeekday = refDate.getDay();
  let backwardCount = weekday - refWeekday;
  if (backwardCount >= 0) {
    backwardCount -= 7;
  }
  return backwardCount;
}
__name(getBackwardDaysToWeekday, "getBackwardDaysToWeekday");

// node_modules/chrono-node/dist/esm/common/refiners/ForwardDateRefiner.js
var ForwardDateRefiner = class {
  static {
    __name(this, "ForwardDateRefiner");
  }
  refine(context, results) {
    if (!context.option.forwardDate) {
      return results;
    }
    results.forEach((result) => {
      let refDate = context.reference.getDateWithAdjustedTimezone();
      if (result.start.isOnlyTime() && context.reference.instant > result.start.date()) {
        const refDate2 = context.reference.getDateWithAdjustedTimezone();
        const refFollowingDay = new Date(refDate2);
        refFollowingDay.setDate(refFollowingDay.getDate() + 1);
        implySimilarDate(result.start, refFollowingDay);
        context.debug(() => {
          console.log(`${this.constructor.name} adjusted ${result} time from the ref date (${refDate2}) to the following day (${refFollowingDay})`);
        });
        if (result.end && result.end.isOnlyTime()) {
          implySimilarDate(result.end, refFollowingDay);
          if (result.start.date() > result.end.date()) {
            refFollowingDay.setDate(refFollowingDay.getDate() + 1);
            implySimilarDate(result.end, refFollowingDay);
          }
        }
      }
      if (result.start.isOnlyWeekdayComponent() && refDate > result.start.date()) {
        let daysToAdd = getDaysForwardToWeekday(refDate, result.start.get("weekday")) || 7;
        const forwardedWeekday = addDuration(refDate, { day: daysToAdd });
        implySimilarDate(result.start, forwardedWeekday);
        context.debug(() => {
          console.log(`${this.constructor.name} adjusted ${result} weekday (${result.start})`);
        });
        if (result.end && result.start.date() > result.end.date()) {
          let daysToAdd2 = getDaysForwardToWeekday(refDate, result.start.get("weekday")) || 7;
          const forwardedWeekday2 = addDuration(refDate, { day: daysToAdd2 });
          implySimilarDate(result.end, forwardedWeekday2);
          context.debug(() => {
            console.log(`${this.constructor.name} adjusted ${result} weekday (${result.end})`);
          });
        }
      }
      if (result.start.isDateWithUnknownYear() && refDate > result.start.date()) {
        for (let i = 0; i < 3 && refDate > result.start.date(); i++) {
          result.start.imply("year", result.start.get("year") + 1);
          context.debug(() => {
            console.log(`${this.constructor.name} adjusted ${result} year (${result.start})`);
          });
          if (result.end && !result.end.isCertain("year")) {
            result.end.imply("year", result.end.get("year") + 1);
            context.debug(() => {
              console.log(`${this.constructor.name} adjusted ${result} month (${result.start})`);
            });
          }
        }
      }
    });
    return results;
  }
};

// node_modules/chrono-node/dist/esm/common/refiners/UnlikelyFormatFilter.js
var UnlikelyFormatFilter = class extends Filter {
  static {
    __name(this, "UnlikelyFormatFilter");
  }
  strictMode;
  constructor(strictMode) {
    super();
    this.strictMode = strictMode;
  }
  isValid(context, result) {
    if (result.text.replace(" ", "").match(/^\d*(\.\d*)?$/)) {
      context.debug(() => {
        console.log(`Removing unlikely result '${result.text}'`);
      });
      return false;
    }
    if (!result.start.isValidDate()) {
      context.debug(() => {
        console.log(`Removing invalid result: ${result} (${result.start})`);
      });
      return false;
    }
    if (result.end && !result.end.isValidDate()) {
      context.debug(() => {
        console.log(`Removing invalid result: ${result} (${result.end})`);
      });
      return false;
    }
    if (this.strictMode) {
      return this.isStrictModeValid(context, result);
    }
    return true;
  }
  isStrictModeValid(context, result) {
    if (result.start.isOnlyWeekdayComponent()) {
      context.debug(() => {
        console.log(`(Strict) Removing weekday only component: ${result} (${result.end})`);
      });
      return false;
    }
    return true;
  }
};

// node_modules/chrono-node/dist/esm/common/parsers/ISOFormatParser.js
var PATTERN9 = new RegExp("([0-9]{4})\\-([0-9]{1,2})\\-([0-9]{1,2})(?:T([0-9]{1,2}):([0-9]{1,2})(?::([0-9]{1,2})(?:\\.(\\d{1,4}))?)?(Z|([+-]\\d{2}):?(\\d{2})?)?)?(?=\\W|$)", "i");
var YEAR_NUMBER_GROUP2 = 1;
var MONTH_NUMBER_GROUP2 = 2;
var DATE_NUMBER_GROUP2 = 3;
var HOUR_NUMBER_GROUP = 4;
var MINUTE_NUMBER_GROUP = 5;
var SECOND_NUMBER_GROUP = 6;
var MILLISECOND_NUMBER_GROUP = 7;
var TZD_GROUP = 8;
var TZD_HOUR_OFFSET_GROUP = 9;
var TZD_MINUTE_OFFSET_GROUP = 10;
var ISOFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ISOFormatParser");
  }
  innerPattern() {
    return PATTERN9;
  }
  innerExtract(context, match) {
    const components = context.createParsingComponents({
      "year": parseInt(match[YEAR_NUMBER_GROUP2]),
      "month": parseInt(match[MONTH_NUMBER_GROUP2]),
      "day": parseInt(match[DATE_NUMBER_GROUP2])
    });
    if (match[HOUR_NUMBER_GROUP] != null) {
      components.assign("hour", parseInt(match[HOUR_NUMBER_GROUP]));
      components.assign("minute", parseInt(match[MINUTE_NUMBER_GROUP]));
      if (match[SECOND_NUMBER_GROUP] != null) {
        components.assign("second", parseInt(match[SECOND_NUMBER_GROUP]));
      }
      if (match[MILLISECOND_NUMBER_GROUP] != null) {
        components.assign("millisecond", parseInt(match[MILLISECOND_NUMBER_GROUP]));
      }
      if (match[TZD_GROUP] != null) {
        let offset = 0;
        if (match[TZD_HOUR_OFFSET_GROUP]) {
          const hourOffset = parseInt(match[TZD_HOUR_OFFSET_GROUP]);
          let minuteOffset = 0;
          if (match[TZD_MINUTE_OFFSET_GROUP] != null) {
            minuteOffset = parseInt(match[TZD_MINUTE_OFFSET_GROUP]);
          }
          offset = hourOffset * 60;
          if (offset < 0) {
            offset -= minuteOffset;
          } else {
            offset += minuteOffset;
          }
        }
        components.assign("timezoneOffset", offset);
      }
    }
    return components.addTag("parser/ISOFormatParser");
  }
};

// node_modules/chrono-node/dist/esm/common/refiners/MergeWeekdayComponentRefiner.js
var MergeWeekdayComponentRefiner = class extends MergingRefiner {
  static {
    __name(this, "MergeWeekdayComponentRefiner");
  }
  mergeResults(textBetween, currentResult, nextResult) {
    const newResult = nextResult.clone();
    newResult.index = currentResult.index;
    newResult.text = currentResult.text + textBetween + newResult.text;
    newResult.start.assign("weekday", currentResult.start.get("weekday"));
    if (newResult.end) {
      newResult.end.assign("weekday", currentResult.start.get("weekday"));
    }
    return newResult;
  }
  shouldMergeResults(textBetween, currentResult, nextResult) {
    const weekdayThenNormalDate = currentResult.start.isOnlyWeekdayComponent() && !currentResult.start.isCertain("hour") && nextResult.start.isCertain("day");
    return weekdayThenNormalDate && textBetween.match(/^,?\s*$/) != null;
  }
};

// node_modules/chrono-node/dist/esm/configurations.js
function includeCommonConfiguration(configuration, strictMode = false) {
  configuration.parsers.unshift(new ISOFormatParser());
  configuration.refiners.unshift(new MergeWeekdayComponentRefiner());
  configuration.refiners.unshift(new ExtractTimezoneOffsetRefiner());
  configuration.refiners.unshift(new OverlapRemovalRefiner());
  configuration.refiners.push(new ExtractTimezoneAbbrRefiner());
  configuration.refiners.push(new OverlapRemovalRefiner());
  configuration.refiners.push(new ForwardDateRefiner());
  configuration.refiners.push(new UnlikelyFormatFilter(strictMode));
  return configuration;
}
__name(includeCommonConfiguration, "includeCommonConfiguration");

// node_modules/chrono-node/dist/esm/common/casualReferences.js
function now(reference) {
  const targetDate = reference.getDateWithAdjustedTimezone();
  const component = new ParsingComponents(reference, {});
  assignSimilarDate(component, targetDate);
  assignSimilarTime(component, targetDate);
  component.assign("timezoneOffset", reference.getTimezoneOffset());
  component.addTag("casualReference/now");
  return component;
}
__name(now, "now");
function today(reference) {
  const targetDate = reference.getDateWithAdjustedTimezone();
  const component = new ParsingComponents(reference, {});
  assignSimilarDate(component, targetDate);
  implySimilarTime(component, targetDate);
  component.delete("meridiem");
  component.addTag("casualReference/today");
  return component;
}
__name(today, "today");
function yesterday(reference) {
  return theDayBefore(reference, 1).addTag("casualReference/yesterday");
}
__name(yesterday, "yesterday");
function tomorrow(reference) {
  return theDayAfter(reference, 1).addTag("casualReference/tomorrow");
}
__name(tomorrow, "tomorrow");
function theDayBefore(reference, numDay) {
  return theDayAfter(reference, -numDay);
}
__name(theDayBefore, "theDayBefore");
function theDayAfter(reference, nDays) {
  const targetDate = reference.getDateWithAdjustedTimezone();
  const component = new ParsingComponents(reference, {});
  const newDate = new Date(targetDate.getTime());
  newDate.setDate(newDate.getDate() + nDays);
  assignSimilarDate(component, newDate);
  implySimilarTime(component, newDate);
  component.delete("meridiem");
  return component;
}
__name(theDayAfter, "theDayAfter");
function tonight(reference, implyHour = 22) {
  const targetDate = reference.getDateWithAdjustedTimezone();
  const component = new ParsingComponents(reference, {});
  assignSimilarDate(component, targetDate);
  component.imply("hour", implyHour);
  component.imply("meridiem", Meridiem.PM);
  component.addTag("casualReference/tonight");
  return component;
}
__name(tonight, "tonight");
function evening(reference, implyHour = 20) {
  const component = new ParsingComponents(reference, {});
  component.imply("meridiem", Meridiem.PM);
  component.imply("hour", implyHour);
  component.addTag("casualReference/evening");
  return component;
}
__name(evening, "evening");
function midnight(reference) {
  const component = new ParsingComponents(reference, {});
  if (reference.getDateWithAdjustedTimezone().getHours() > 2) {
    component.addDurationAsImplied({ day: 1 });
  }
  component.assign("hour", 0);
  component.imply("minute", 0);
  component.imply("second", 0);
  component.imply("millisecond", 0);
  component.addTag("casualReference/midnight");
  return component;
}
__name(midnight, "midnight");
function morning(reference, implyHour = 6) {
  const component = new ParsingComponents(reference, {});
  component.imply("meridiem", Meridiem.AM);
  component.imply("hour", implyHour);
  component.imply("minute", 0);
  component.imply("second", 0);
  component.imply("millisecond", 0);
  component.addTag("casualReference/morning");
  return component;
}
__name(morning, "morning");
function afternoon(reference, implyHour = 15) {
  const component = new ParsingComponents(reference, {});
  component.imply("meridiem", Meridiem.PM);
  component.imply("hour", implyHour);
  component.imply("minute", 0);
  component.imply("second", 0);
  component.imply("millisecond", 0);
  component.addTag("casualReference/afternoon");
  return component;
}
__name(afternoon, "afternoon");
function noon(reference) {
  const component = new ParsingComponents(reference, {});
  component.imply("meridiem", Meridiem.AM);
  component.assign("hour", 12);
  component.imply("minute", 0);
  component.imply("second", 0);
  component.imply("millisecond", 0);
  component.addTag("casualReference/noon");
  return component;
}
__name(noon, "noon");

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENCasualDateParser.js
var PATTERN10 = /(now|today|tonight|tomorrow|overmorrow|tmr|tmrw|yesterday|last\s*night)(?=\W|$)/i;
var ENCasualDateParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENCasualDateParser");
  }
  innerPattern(context) {
    return PATTERN10;
  }
  innerExtract(context, match) {
    let targetDate = context.refDate;
    const lowerText = match[0].toLowerCase();
    let component = context.createParsingComponents();
    switch (lowerText) {
      case "now":
        component = now(context.reference);
        break;
      case "today":
        component = today(context.reference);
        break;
      case "yesterday":
        component = yesterday(context.reference);
        break;
      case "tomorrow":
      case "tmr":
      case "tmrw":
        component = tomorrow(context.reference);
        break;
      case "tonight":
        component = tonight(context.reference);
        break;
      case "overmorrow":
        component = theDayAfter(context.reference, 2);
        break;
      default:
        if (lowerText.match(/last\s*night/)) {
          if (targetDate.getHours() > 6) {
            const previousDay = new Date(targetDate.getTime());
            previousDay.setDate(previousDay.getDate() - 1);
            targetDate = previousDay;
          }
          assignSimilarDate(component, targetDate);
          component.imply("hour", 0);
        }
        break;
    }
    component.addTag("parser/ENCasualDateParser");
    return component;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENCasualTimeParser.js
var PATTERN11 = /(?:this)?\s{0,3}(morning|afternoon|evening|night|midnight|midday|noon)(?=\W|$)/i;
var ENCasualTimeParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENCasualTimeParser");
  }
  innerPattern() {
    return PATTERN11;
  }
  innerExtract(context, match) {
    let component = null;
    switch (match[1].toLowerCase()) {
      case "afternoon":
        component = afternoon(context.reference);
        break;
      case "evening":
      case "night":
        component = evening(context.reference);
        break;
      case "midnight":
        component = midnight(context.reference);
        break;
      case "morning":
        component = morning(context.reference);
        break;
      case "noon":
      case "midday":
        component = noon(context.reference);
        break;
    }
    if (component) {
      component.addTag("parser/ENCasualTimeParser");
    }
    return component;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENWeekdayParser.js
var PATTERN12 = new RegExp(`(?:(?:\\,|\\(|\\\uFF08)\\s*)?(?:on\\s*?)?(?:(this|last|past|next)\\s*)?(${matchAnyPattern(WEEKDAY_DICTIONARY)}|weekend|weekday)(?:\\s*(?:\\,|\\)|\\\uFF09))?(?:\\s*(?:of\\s*)?(this|last|past|next)\\s*week)?(?=\\W|$)`, "i");
var PREFIX_GROUP2 = 1;
var WEEKDAY_GROUP = 2;
var POSTFIX_GROUP = 3;
var ENWeekdayParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENWeekdayParser");
  }
  innerPattern() {
    return PATTERN12;
  }
  innerExtract(context, match) {
    const prefix = match[PREFIX_GROUP2];
    const postfix = match[POSTFIX_GROUP];
    let modifierWord = prefix || postfix;
    modifierWord = modifierWord || "";
    modifierWord = modifierWord.toLowerCase();
    let modifier = null;
    if (modifierWord == "last" || modifierWord == "past") {
      modifier = "last";
    } else if (modifierWord == "next") {
      modifier = "next";
    } else if (modifierWord == "this") {
      modifier = "this";
    }
    const weekday_word = match[WEEKDAY_GROUP].toLowerCase();
    let weekday;
    if (WEEKDAY_DICTIONARY[weekday_word] !== void 0) {
      weekday = WEEKDAY_DICTIONARY[weekday_word];
    } else if (weekday_word == "weekend") {
      weekday = modifier == "last" ? Weekday.SUNDAY : Weekday.SATURDAY;
    } else if (weekday_word == "weekday") {
      const refWeekday = context.reference.getDateWithAdjustedTimezone().getDay();
      if (refWeekday == Weekday.SUNDAY || refWeekday == Weekday.SATURDAY) {
        weekday = modifier == "last" ? Weekday.FRIDAY : Weekday.MONDAY;
      } else {
        weekday = refWeekday - 1;
        weekday = modifier == "last" ? weekday - 1 : weekday + 1;
        weekday = weekday % 5 + 1;
      }
    } else {
      return null;
    }
    return createParsingComponentsAtWeekday(context.reference, weekday, modifier);
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENRelativeDateFormatParser.js
var PATTERN13 = new RegExp(`(this|last|past|next|after\\s*this)\\s*(${matchAnyPattern(TIME_UNIT_DICTIONARY)})(?=\\s*)(?=\\W|$)`, "i");
var MODIFIER_WORD_GROUP = 1;
var RELATIVE_WORD_GROUP = 2;
var ENRelativeDateFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENRelativeDateFormatParser");
  }
  innerPattern() {
    return PATTERN13;
  }
  innerExtract(context, match) {
    const modifier = match[MODIFIER_WORD_GROUP].toLowerCase();
    const unitWord = match[RELATIVE_WORD_GROUP].toLowerCase();
    const timeunit = TIME_UNIT_DICTIONARY[unitWord];
    if (modifier == "next" || modifier.startsWith("after")) {
      const timeUnits = {};
      timeUnits[timeunit] = 1;
      return ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
    }
    if (modifier == "last" || modifier == "past") {
      const timeUnits = {};
      timeUnits[timeunit] = -1;
      return ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
    }
    const components = context.createParsingComponents();
    let date = new Date(context.reference.instant.getTime());
    if (unitWord.match(/week/i)) {
      date.setDate(date.getDate() - date.getDay());
      components.imply("day", date.getDate());
      components.imply("month", date.getMonth() + 1);
      components.imply("year", date.getFullYear());
    } else if (unitWord.match(/month/i)) {
      date.setDate(1);
      components.imply("day", date.getDate());
      components.assign("year", date.getFullYear());
      components.assign("month", date.getMonth() + 1);
    } else if (unitWord.match(/year/i)) {
      date.setDate(1);
      date.setMonth(0);
      components.imply("day", date.getDate());
      components.imply("month", date.getMonth() + 1);
      components.assign("year", date.getFullYear());
    }
    return components;
  }
};

// node_modules/chrono-node/dist/esm/common/parsers/SlashDateFormatParser.js
var PATTERN14 = new RegExp("([^\\d]|^)([0-3]{0,1}[0-9]{1})[\\/\\.\\-]([0-3]{0,1}[0-9]{1})(?:[\\/\\.\\-]([0-9]{4}|[0-9]{2}))?(\\W|$)", "i");
var OPENING_GROUP = 1;
var ENDING_GROUP = 5;
var FIRST_NUMBERS_GROUP = 2;
var SECOND_NUMBERS_GROUP = 3;
var YEAR_GROUP6 = 4;
var SlashDateFormatParser = class {
  static {
    __name(this, "SlashDateFormatParser");
  }
  groupNumberMonth;
  groupNumberDay;
  constructor(littleEndian) {
    this.groupNumberMonth = littleEndian ? SECOND_NUMBERS_GROUP : FIRST_NUMBERS_GROUP;
    this.groupNumberDay = littleEndian ? FIRST_NUMBERS_GROUP : SECOND_NUMBERS_GROUP;
  }
  pattern() {
    return PATTERN14;
  }
  extract(context, match) {
    const index = match.index + match[OPENING_GROUP].length;
    const indexEnd = match.index + match[0].length - match[ENDING_GROUP].length;
    if (index > 0) {
      const textBefore = context.text.substring(0, index);
      if (textBefore.match("\\d/?$")) {
        return;
      }
    }
    if (indexEnd < context.text.length) {
      const textAfter = context.text.substring(indexEnd);
      if (textAfter.match("^/?\\d")) {
        return;
      }
    }
    const text2 = context.text.substring(index, indexEnd);
    if (text2.match(/^\d\.\d$/) || text2.match(/^\d\.\d{1,2}\.\d{1,2}\s*$/)) {
      return;
    }
    if (!match[YEAR_GROUP6] && text2.indexOf("/") < 0) {
      return;
    }
    const result = context.createParsingResult(index, text2);
    let month = parseInt(match[this.groupNumberMonth]);
    let day = parseInt(match[this.groupNumberDay]);
    if (month < 1 || month > 12) {
      if (month > 12) {
        if (day >= 1 && day <= 12 && month <= 31) {
          [day, month] = [month, day];
        } else {
          return null;
        }
      }
    }
    if (day < 1 || day > 31) {
      return null;
    }
    result.start.assign("day", day);
    result.start.assign("month", month);
    if (match[YEAR_GROUP6]) {
      const rawYearNumber = parseInt(match[YEAR_GROUP6]);
      const year = findMostLikelyADYear(rawYearNumber);
      result.start.assign("year", year);
    } else {
      const year = findYearClosestToRef(context.refDate, day, month);
      result.start.imply("year", year);
    }
    return result.addTag("parser/SlashDateFormatParser");
  }
};

// node_modules/chrono-node/dist/esm/locales/en/parsers/ENTimeUnitCasualRelativeFormatParser.js
var PATTERN15 = new RegExp(`(this|last|past|next|after|\\+|-)\\s*(${TIME_UNITS_PATTERN})(?=\\W|$)`, "i");
var PATTERN_NO_ABBR = new RegExp(`(this|last|past|next|after|\\+|-)\\s*(${TIME_UNITS_NO_ABBR_PATTERN})(?=\\W|$)`, "i");
var ENTimeUnitCasualRelativeFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ENTimeUnitCasualRelativeFormatParser");
  }
  allowAbbreviations;
  constructor(allowAbbreviations = true) {
    super();
    this.allowAbbreviations = allowAbbreviations;
  }
  innerPattern() {
    return this.allowAbbreviations ? PATTERN15 : PATTERN_NO_ABBR;
  }
  innerExtract(context, match) {
    const prefix = match[1].toLowerCase();
    let duration = parseDuration(match[2]);
    if (!duration) {
      return null;
    }
    switch (prefix) {
      case "last":
      case "past":
      case "-":
        duration = reverseDuration(duration);
        break;
    }
    return ParsingComponents.createRelativeFromReference(context.reference, duration);
  }
};

// node_modules/chrono-node/dist/esm/locales/en/refiners/ENMergeRelativeAfterDateRefiner.js
function IsPositiveFollowingReference(result) {
  return result.text.match(/^[+-]/i) != null;
}
__name(IsPositiveFollowingReference, "IsPositiveFollowingReference");
function IsNegativeFollowingReference(result) {
  return result.text.match(/^-/i) != null;
}
__name(IsNegativeFollowingReference, "IsNegativeFollowingReference");
var ENMergeRelativeAfterDateRefiner = class extends MergingRefiner {
  static {
    __name(this, "ENMergeRelativeAfterDateRefiner");
  }
  shouldMergeResults(textBetween, currentResult, nextResult) {
    if (!textBetween.match(/^\s*$/i)) {
      return false;
    }
    return IsPositiveFollowingReference(nextResult) || IsNegativeFollowingReference(nextResult);
  }
  mergeResults(textBetween, currentResult, nextResult, context) {
    let timeUnits = parseDuration(nextResult.text);
    if (IsNegativeFollowingReference(nextResult)) {
      timeUnits = reverseDuration(timeUnits);
    }
    const components = ParsingComponents.createRelativeFromReference(ReferenceWithTimezone.fromDate(currentResult.start.date()), timeUnits);
    return new ParsingResult(currentResult.reference, currentResult.index, `${currentResult.text}${textBetween}${nextResult.text}`, components);
  }
};

// node_modules/chrono-node/dist/esm/locales/en/refiners/ENMergeRelativeFollowByDateRefiner.js
function hasImpliedEarlierReferenceDate(result) {
  return result.text.match(/\s+(before|from)$/i) != null;
}
__name(hasImpliedEarlierReferenceDate, "hasImpliedEarlierReferenceDate");
function hasImpliedLaterReferenceDate(result) {
  return result.text.match(/\s+(after|since)$/i) != null;
}
__name(hasImpliedLaterReferenceDate, "hasImpliedLaterReferenceDate");
var ENMergeRelativeFollowByDateRefiner = class extends MergingRefiner {
  static {
    __name(this, "ENMergeRelativeFollowByDateRefiner");
  }
  patternBetween() {
    return /^\s*$/i;
  }
  shouldMergeResults(textBetween, currentResult, nextResult) {
    if (!textBetween.match(this.patternBetween())) {
      return false;
    }
    if (!hasImpliedEarlierReferenceDate(currentResult) && !hasImpliedLaterReferenceDate(currentResult)) {
      return false;
    }
    return !!nextResult.start.get("day") && !!nextResult.start.get("month") && !!nextResult.start.get("year");
  }
  mergeResults(textBetween, currentResult, nextResult) {
    let duration = parseDuration(currentResult.text);
    if (hasImpliedEarlierReferenceDate(currentResult)) {
      duration = reverseDuration(duration);
    }
    const components = ParsingComponents.createRelativeFromReference(ReferenceWithTimezone.fromDate(nextResult.start.date()), duration);
    return new ParsingResult(nextResult.reference, currentResult.index, `${currentResult.text}${textBetween}${nextResult.text}`, components);
  }
};

// node_modules/chrono-node/dist/esm/locales/en/refiners/ENExtractYearSuffixRefiner.js
var YEAR_SUFFIX_PATTERN = new RegExp(`^\\s*(${YEAR_PATTERN})`, "i");
var YEAR_GROUP7 = 1;
var ENExtractYearSuffixRefiner = class {
  static {
    __name(this, "ENExtractYearSuffixRefiner");
  }
  refine(context, results) {
    results.forEach(function(result) {
      if (!result.start.isDateWithUnknownYear()) {
        return;
      }
      const suffix = context.text.substring(result.index + result.text.length);
      const match = YEAR_SUFFIX_PATTERN.exec(suffix);
      if (!match) {
        return;
      }
      if (match[0].trim().length <= 3) {
        return;
      }
      context.debug(() => {
        console.log(`Extracting year: '${match[0]}' into : ${result}`);
      });
      const year = parseYear(match[YEAR_GROUP7]);
      if (result.end != null) {
        result.end.assign("year", year);
      }
      result.start.assign("year", year);
      result.text += match[0];
    });
    return results;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/refiners/ENUnlikelyFormatFilter.js
var ENUnlikelyFormatFilter = class extends Filter {
  static {
    __name(this, "ENUnlikelyFormatFilter");
  }
  constructor() {
    super();
  }
  isValid(context, result) {
    const text2 = result.text.trim();
    if (text2 === context.text.trim()) {
      return true;
    }
    if (text2.toLowerCase() === "may") {
      const textBefore = context.text.substring(0, result.index).trim();
      if (!textBefore.match(/\b(in)$/i)) {
        context.debug(() => {
          console.log(`Removing unlikely result: ${result}`);
        });
        return false;
      }
    }
    if (text2.toLowerCase().endsWith("the second")) {
      const textAfter = context.text.substring(result.index + result.text.length).trim();
      if (textAfter.length > 0) {
        context.debug(() => {
          console.log(`Removing unlikely result: ${result}`);
        });
      }
      return false;
    }
    return true;
  }
};

// node_modules/chrono-node/dist/esm/locales/en/configuration.js
var ENDefaultConfiguration = class {
  static {
    __name(this, "ENDefaultConfiguration");
  }
  createCasualConfiguration(littleEndian = false) {
    const option = this.createConfiguration(false, littleEndian);
    option.parsers.push(new ENCasualDateParser());
    option.parsers.push(new ENCasualTimeParser());
    option.parsers.push(new ENMonthNameParser());
    option.parsers.push(new ENRelativeDateFormatParser());
    option.parsers.push(new ENTimeUnitCasualRelativeFormatParser());
    option.refiners.push(new ENUnlikelyFormatFilter());
    return option;
  }
  createConfiguration(strictMode = true, littleEndian = false) {
    const options = includeCommonConfiguration({
      parsers: [
        new SlashDateFormatParser(littleEndian),
        new ENTimeUnitWithinFormatParser(strictMode),
        new ENMonthNameLittleEndianParser(),
        new ENMonthNameMiddleEndianParser(littleEndian),
        new ENWeekdayParser(),
        new ENSlashMonthFormatParser(),
        new ENTimeExpressionParser(strictMode),
        new ENTimeUnitAgoFormatParser(strictMode),
        new ENTimeUnitLaterFormatParser(strictMode),
        new ENYearMonthNameParser()
      ],
      refiners: [new ENMergeDateTimeRefiner()]
    }, strictMode);
    options.parsers.unshift(new ENYearMonthDayParser(strictMode));
    options.refiners.unshift(new ENMergeRelativeFollowByDateRefiner());
    options.refiners.unshift(new ENMergeRelativeAfterDateRefiner());
    options.refiners.unshift(new OverlapRemovalRefiner());
    options.refiners.push(new ENMergeDateTimeRefiner());
    options.refiners.push(new ENExtractYearSuffixRefiner());
    options.refiners.push(new ENMergeDateRangeRefiner());
    return options;
  }
};

// node_modules/chrono-node/dist/esm/chrono.js
var Chrono = class _Chrono {
  static {
    __name(this, "Chrono");
  }
  parsers;
  refiners;
  defaultConfig = new ENDefaultConfiguration();
  constructor(configuration) {
    configuration = configuration || this.defaultConfig.createCasualConfiguration();
    this.parsers = [...configuration.parsers];
    this.refiners = [...configuration.refiners];
  }
  clone() {
    return new _Chrono({
      parsers: [...this.parsers],
      refiners: [...this.refiners]
    });
  }
  parseDate(text2, referenceDate, option) {
    const results = this.parse(text2, referenceDate, option);
    return results.length > 0 ? results[0].start.date() : null;
  }
  parse(text2, referenceDate, option) {
    const context = new ParsingContext(text2, referenceDate, option);
    let results = [];
    this.parsers.forEach((parser) => {
      const parsedResults = _Chrono.executeParser(context, parser);
      results = results.concat(parsedResults);
    });
    results.sort((a, b) => {
      return a.index - b.index;
    });
    this.refiners.forEach(function(refiner) {
      results = refiner.refine(context, results);
    });
    return results;
  }
  static executeParser(context, parser) {
    const results = [];
    const pattern = parser.pattern(context);
    const originalText = context.text;
    let remainingText = context.text;
    let match = pattern.exec(remainingText);
    while (match) {
      const index = match.index + originalText.length - remainingText.length;
      match.index = index;
      const result = parser.extract(context, match);
      if (!result) {
        remainingText = originalText.substring(match.index + 1);
        match = pattern.exec(remainingText);
        continue;
      }
      let parsedResult = null;
      if (result instanceof ParsingResult) {
        parsedResult = result;
      } else if (result instanceof ParsingComponents) {
        parsedResult = context.createParsingResult(match.index, match[0]);
        parsedResult.start = result;
      } else {
        parsedResult = context.createParsingResult(match.index, match[0], result);
      }
      const parsedIndex = parsedResult.index;
      const parsedText = parsedResult.text;
      context.debug(() => console.log(`${parser.constructor.name} extracted (at index=${parsedIndex}) '${parsedText}'`));
      results.push(parsedResult);
      remainingText = originalText.substring(parsedIndex + parsedText.length);
      match = pattern.exec(remainingText);
    }
    return results;
  }
};
var ParsingContext = class {
  static {
    __name(this, "ParsingContext");
  }
  text;
  option;
  reference;
  refDate;
  constructor(text2, refDate, option) {
    this.text = text2;
    this.option = option ?? {};
    this.reference = ReferenceWithTimezone.fromInput(refDate, this.option.timezones);
    this.refDate = this.reference.instant;
  }
  createParsingComponents(components) {
    if (components instanceof ParsingComponents) {
      return components;
    }
    return new ParsingComponents(this.reference, components);
  }
  createParsingResult(index, textOrEndIndex, startComponents, endComponents) {
    const text2 = typeof textOrEndIndex === "string" ? textOrEndIndex : this.text.substring(index, textOrEndIndex);
    const start = startComponents ? this.createParsingComponents(startComponents) : null;
    const end = endComponents ? this.createParsingComponents(endComponents) : null;
    return new ParsingResult(this.reference, index, text2, start, end);
  }
  debug(block) {
    if (this.option.debug) {
      if (this.option.debug instanceof Function) {
        this.option.debug(block);
      } else {
        const handler = this.option.debug;
        handler.debug(block);
      }
    }
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/index.js
var zh_exports = {};
__export(zh_exports, {
  Chrono: () => Chrono,
  Meridiem: () => Meridiem,
  ParsingComponents: () => ParsingComponents,
  ParsingResult: () => ParsingResult,
  ReferenceWithTimezone: () => ReferenceWithTimezone,
  Weekday: () => Weekday,
  casual: () => casual3,
  createCasualConfiguration: () => createCasualConfiguration3,
  createConfiguration: () => createConfiguration3,
  hans: () => hans_exports,
  hant: () => hant_exports,
  parse: () => parse3,
  parseDate: () => parseDate3,
  strict: () => strict3
});

// node_modules/chrono-node/dist/esm/locales/zh/hans/constants.js
var NUMBER = {
  "\u96F6": 0,
  "\u3007": 0,
  "\u4E00": 1,
  "\u4E8C": 2,
  "\u4E24": 2,
  "\u4E09": 3,
  "\u56DB": 4,
  "\u4E94": 5,
  "\u516D": 6,
  "\u4E03": 7,
  "\u516B": 8,
  "\u4E5D": 9,
  "\u5341": 10
};
var WEEKDAY_OFFSET = {
  "\u5929": 0,
  "\u65E5": 0,
  "\u4E00": 1,
  "\u4E8C": 2,
  "\u4E09": 3,
  "\u56DB": 4,
  "\u4E94": 5,
  "\u516D": 6
};
function zhStringToNumber(text2) {
  let number = 0;
  for (let i = 0; i < text2.length; i++) {
    const char = text2[i];
    if (char === "\u5341") {
      number = number === 0 ? NUMBER[char] : number * NUMBER[char];
    } else {
      number += NUMBER[char];
    }
  }
  return number;
}
__name(zhStringToNumber, "zhStringToNumber");
function zhStringToYear(text2) {
  let string = "";
  for (let i = 0; i < text2.length; i++) {
    const char = text2[i];
    string = string + NUMBER[char];
  }
  return parseInt(string);
}
__name(zhStringToYear, "zhStringToYear");

// node_modules/chrono-node/dist/esm/locales/zh/hans/parsers/ZHHansDateParser.js
var YEAR_GROUP8 = 1;
var MONTH_GROUP2 = 2;
var DAY_GROUP = 3;
var ZHHansDateParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHansDateParser");
  }
  innerPattern() {
    return new RegExp("(\\d{2,4}|[" + Object.keys(NUMBER).join("") + "]{4}|[" + Object.keys(NUMBER).join("") + "]{2})?(?:\\s*)(?:\u5E74)?(?:[\\s|,|\uFF0C]*)(\\d{1,2}|[" + Object.keys(NUMBER).join("") + "]{1,3})(?:\\s*)(?:\u6708)(?:\\s*)(\\d{1,2}|[" + Object.keys(NUMBER).join("") + "]{1,3})?(?:\\s*)(?:\u65E5|\u53F7)?");
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    let month = parseInt(match[MONTH_GROUP2]);
    if (isNaN(month))
      month = zhStringToNumber(match[MONTH_GROUP2]);
    result.start.assign("month", month);
    if (match[DAY_GROUP]) {
      let day = parseInt(match[DAY_GROUP]);
      if (isNaN(day))
        day = zhStringToNumber(match[DAY_GROUP]);
      result.start.assign("day", day);
    } else {
      result.start.imply("day", context.refDate.getDate());
    }
    if (match[YEAR_GROUP8]) {
      let year = parseInt(match[YEAR_GROUP8]);
      if (isNaN(year))
        year = zhStringToYear(match[YEAR_GROUP8]);
      result.start.assign("year", year);
    } else {
      result.start.imply("year", context.refDate.getFullYear());
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hans/parsers/ZHHansDeadlineFormatParser.js
var PATTERN16 = new RegExp("(\\d+|[" + Object.keys(NUMBER).join("") + "]+|\u534A|\u51E0)(?:\\s*)(?:\u4E2A)?(\u79D2(?:\u949F)?|\u5206\u949F|\u5C0F\u65F6|\u949F|\u65E5|\u5929|\u661F\u671F|\u793C\u62DC|\u6708|\u5E74)(?:(?:\u4E4B|\u8FC7)?\u540E|(?:\u4E4B)?\u5185)", "i");
var NUMBER_GROUP = 1;
var UNIT_GROUP = 2;
var ZHHansDeadlineFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHansDeadlineFormatParser");
  }
  innerPattern() {
    return PATTERN16;
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    let number = parseInt(match[NUMBER_GROUP]);
    if (isNaN(number)) {
      number = zhStringToNumber(match[NUMBER_GROUP]);
    }
    if (isNaN(number)) {
      const string = match[NUMBER_GROUP];
      if (string === "\u51E0") {
        number = 3;
      } else if (string === "\u534A") {
        number = 0.5;
      } else {
        return null;
      }
    }
    const duration = {};
    const unit = match[UNIT_GROUP];
    const unitAbbr = unit[0];
    if (unitAbbr.match(/[日天星礼月年]/)) {
      if (unitAbbr == "\u65E5" || unitAbbr == "\u5929") {
        duration.day = number;
      } else if (unitAbbr == "\u661F" || unitAbbr == "\u793C") {
        duration.week = number;
      } else if (unitAbbr == "\u6708") {
        duration.month = number;
      } else if (unitAbbr == "\u5E74") {
        duration.year = number;
      }
      const date2 = addDuration(context.refDate, duration);
      result.start.assign("year", date2.getFullYear());
      result.start.assign("month", date2.getMonth() + 1);
      result.start.assign("day", date2.getDate());
      return result;
    }
    if (unitAbbr == "\u79D2") {
      duration.second = number;
    } else if (unitAbbr == "\u5206") {
      duration.minute = number;
    } else if (unitAbbr == "\u5C0F" || unitAbbr == "\u949F") {
      duration.hour = number;
    }
    const date = addDuration(context.refDate, duration);
    result.start.imply("year", date.getFullYear());
    result.start.imply("month", date.getMonth() + 1);
    result.start.imply("day", date.getDate());
    result.start.assign("hour", date.getHours());
    result.start.assign("minute", date.getMinutes());
    result.start.assign("second", date.getSeconds());
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hans/parsers/ZHHansRelationWeekdayParser.js
var PATTERN17 = new RegExp("(?<prefix>\u4E0A|\u4E0B|\u8FD9)(?:\u4E2A)?(?:\u661F\u671F|\u793C\u62DC|\u5468)(?<weekday>" + Object.keys(WEEKDAY_OFFSET).join("|") + ")");
var ZHHansRelationWeekdayParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHansRelationWeekdayParser");
  }
  innerPattern() {
    return PATTERN17;
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    const dayOfWeek = match.groups.weekday;
    const offset = WEEKDAY_OFFSET[dayOfWeek];
    if (offset === void 0)
      return null;
    let modifier = null;
    const prefix = match.groups.prefix;
    if (prefix == "\u4E0A") {
      modifier = "last";
    } else if (prefix == "\u4E0B") {
      modifier = "next";
    } else if (prefix == "\u8FD9") {
      modifier = "this";
    }
    const date = new Date(context.refDate.getTime());
    let startMomentFixed = false;
    const refOffset = date.getDay();
    if (modifier == "last" || modifier == "past") {
      date.setDate(date.getDate() + (offset - 7 - refOffset));
      startMomentFixed = true;
    } else if (modifier == "next") {
      date.setDate(date.getDate() + (offset + 7 - refOffset));
      startMomentFixed = true;
    } else if (modifier == "this") {
      date.setDate(date.getDate() + (offset - refOffset));
    } else {
      let diff = offset - refOffset;
      if (Math.abs(diff - 7) < Math.abs(diff)) {
        diff -= 7;
      }
      if (Math.abs(diff + 7) < Math.abs(diff)) {
        diff += 7;
      }
      date.setDate(date.getDate() + diff);
    }
    result.start.assign("weekday", offset);
    if (startMomentFixed) {
      result.start.assign("day", date.getDate());
      result.start.assign("month", date.getMonth() + 1);
      result.start.assign("year", date.getFullYear());
    } else {
      result.start.imply("day", date.getDate());
      result.start.imply("month", date.getMonth() + 1);
      result.start.imply("year", date.getFullYear());
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hans/parsers/ZHHansTimeExpressionParser.js
var FIRST_REG_PATTERN = new RegExp("(?:\u4ECE|\u81EA)?(?:(\u4ECA|\u660E|\u524D|\u5927\u524D|\u540E|\u5927\u540E|\u6628)(\u65E9|\u671D|\u665A)|(\u4E0A(?:\u5348)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668))|(\u4ECA|\u660E|\u524D|\u5927\u524D|\u540E|\u5927\u540E|\u6628)(?:\u65E5|\u5929)(?:[\\s,\uFF0C]*)(?:(\u4E0A(?:\u5348)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668)))?)?(?:[\\s,\uFF0C]*)(?:(\\d+|[" + Object.keys(NUMBER).join("") + "]+)(?:\\s*)(?:\u70B9|\u65F6|:|\uFF1A)(?:\\s*)(\\d+|\u534A|\u6B63|\u6574|[" + Object.keys(NUMBER).join("") + "]+)?(?:\\s*)(?:\u5206|:|\uFF1A)?(?:\\s*)(\\d+|[" + Object.keys(NUMBER).join("") + "]+)?(?:\\s*)(?:\u79D2)?)(?:\\s*(A.M.|P.M.|AM?|PM?))?", "i");
var SECOND_REG_PATTERN = new RegExp("(?:^\\s*(?:\u5230|\u81F3|\\-|\\\u2013|\\~|\\\u301C)\\s*)(?:(\u4ECA|\u660E|\u524D|\u5927\u524D|\u540E|\u5927\u540E|\u6628)(\u65E9|\u671D|\u665A)|(\u4E0A(?:\u5348)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668))|(\u4ECA|\u660E|\u524D|\u5927\u524D|\u540E|\u5927\u540E|\u6628)(?:\u65E5|\u5929)(?:[\\s,\uFF0C]*)(?:(\u4E0A(?:\u5348)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668)))?)?(?:[\\s,\uFF0C]*)(?:(\\d+|[" + Object.keys(NUMBER).join("") + "]+)(?:\\s*)(?:\u70B9|\u65F6|:|\uFF1A)(?:\\s*)(\\d+|\u534A|\u6B63|\u6574|[" + Object.keys(NUMBER).join("") + "]+)?(?:\\s*)(?:\u5206|:|\uFF1A)?(?:\\s*)(\\d+|[" + Object.keys(NUMBER).join("") + "]+)?(?:\\s*)(?:\u79D2)?)(?:\\s*(A.M.|P.M.|AM?|PM?))?", "i");
var DAY_GROUP_1 = 1;
var ZH_AM_PM_HOUR_GROUP_1 = 2;
var ZH_AM_PM_HOUR_GROUP_2 = 3;
var DAY_GROUP_3 = 4;
var ZH_AM_PM_HOUR_GROUP_3 = 5;
var HOUR_GROUP2 = 6;
var MINUTE_GROUP2 = 7;
var SECOND_GROUP2 = 8;
var AM_PM_HOUR_GROUP2 = 9;
var ZHHansTimeExpressionParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHansTimeExpressionParser");
  }
  patternLeftBoundary() {
    return "()";
  }
  innerPattern() {
    return FIRST_REG_PATTERN;
  }
  innerExtract(context, match) {
    if (match.index > 0 && context.text[match.index - 1].match(/\w/)) {
      return null;
    }
    const result = context.createParsingResult(match.index, match[0]);
    const startMoment = new Date(context.reference.instant.getTime());
    if (match[DAY_GROUP_1]) {
      const day1 = match[DAY_GROUP_1];
      if (day1 == "\u660E") {
        if (context.reference.instant.getHours() > 1) {
          startMoment.setDate(startMoment.getDate() + 1);
        }
      } else if (day1 == "\u6628") {
        startMoment.setDate(startMoment.getDate() - 1);
      } else if (day1 == "\u524D") {
        startMoment.setDate(startMoment.getDate() - 2);
      } else if (day1 == "\u5927\u524D") {
        startMoment.setDate(startMoment.getDate() - 3);
      } else if (day1 == "\u540E") {
        startMoment.setDate(startMoment.getDate() + 2);
      } else if (day1 == "\u5927\u540E") {
        startMoment.setDate(startMoment.getDate() + 3);
      }
      result.start.assign("day", startMoment.getDate());
      result.start.assign("month", startMoment.getMonth() + 1);
      result.start.assign("year", startMoment.getFullYear());
    } else if (match[DAY_GROUP_3]) {
      const day3 = match[DAY_GROUP_3];
      if (day3 == "\u660E") {
        startMoment.setDate(startMoment.getDate() + 1);
      } else if (day3 == "\u6628") {
        startMoment.setDate(startMoment.getDate() - 1);
      } else if (day3 == "\u524D") {
        startMoment.setDate(startMoment.getDate() - 2);
      } else if (day3 == "\u5927\u524D") {
        startMoment.setDate(startMoment.getDate() - 3);
      } else if (day3 == "\u540E") {
        startMoment.setDate(startMoment.getDate() + 2);
      } else if (day3 == "\u5927\u540E") {
        startMoment.setDate(startMoment.getDate() + 3);
      }
      result.start.assign("day", startMoment.getDate());
      result.start.assign("month", startMoment.getMonth() + 1);
      result.start.assign("year", startMoment.getFullYear());
    } else {
      result.start.imply("day", startMoment.getDate());
      result.start.imply("month", startMoment.getMonth() + 1);
      result.start.imply("year", startMoment.getFullYear());
    }
    let hour = 0;
    let minute = 0;
    let meridiem = -1;
    if (match[SECOND_GROUP2]) {
      let second = parseInt(match[SECOND_GROUP2]);
      if (isNaN(second)) {
        second = zhStringToNumber(match[SECOND_GROUP2]);
      }
      if (second >= 60)
        return null;
      result.start.assign("second", second);
    }
    hour = parseInt(match[HOUR_GROUP2]);
    if (isNaN(hour)) {
      hour = zhStringToNumber(match[HOUR_GROUP2]);
    }
    if (match[MINUTE_GROUP2]) {
      if (match[MINUTE_GROUP2] == "\u534A") {
        minute = 30;
      } else if (match[MINUTE_GROUP2] == "\u6B63" || match[MINUTE_GROUP2] == "\u6574") {
        minute = 0;
      } else {
        minute = parseInt(match[MINUTE_GROUP2]);
        if (isNaN(minute)) {
          minute = zhStringToNumber(match[MINUTE_GROUP2]);
        }
      }
    } else if (hour > 100) {
      minute = hour % 100;
      hour = Math.floor(hour / 100);
    }
    if (minute >= 60) {
      return null;
    }
    if (hour > 24) {
      return null;
    }
    if (hour >= 12) {
      meridiem = 1;
    }
    if (match[AM_PM_HOUR_GROUP2]) {
      if (hour > 12)
        return null;
      const ampm = match[AM_PM_HOUR_GROUP2][0].toLowerCase();
      if (ampm == "a") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      }
      if (ampm == "p") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (match[ZH_AM_PM_HOUR_GROUP_1]) {
      const zhAMPMString1 = match[ZH_AM_PM_HOUR_GROUP_1];
      const zhAMPM1 = zhAMPMString1[0];
      if (zhAMPM1 == "\u65E9") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM1 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (match[ZH_AM_PM_HOUR_GROUP_2]) {
      const zhAMPMString2 = match[ZH_AM_PM_HOUR_GROUP_2];
      const zhAMPM2 = zhAMPMString2[0];
      if (zhAMPM2 == "\u4E0A" || zhAMPM2 == "\u65E9" || zhAMPM2 == "\u51CC") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM2 == "\u4E0B" || zhAMPM2 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (match[ZH_AM_PM_HOUR_GROUP_3]) {
      const zhAMPMString3 = match[ZH_AM_PM_HOUR_GROUP_3];
      const zhAMPM3 = zhAMPMString3[0];
      if (zhAMPM3 == "\u4E0A" || zhAMPM3 == "\u65E9" || zhAMPM3 == "\u51CC") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM3 == "\u4E0B" || zhAMPM3 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    }
    result.start.assign("hour", hour);
    result.start.assign("minute", minute);
    if (meridiem >= 0) {
      result.start.assign("meridiem", meridiem);
    } else {
      if (hour < 12) {
        result.start.imply("meridiem", 0);
      } else {
        result.start.imply("meridiem", 1);
      }
    }
    const secondMatch = SECOND_REG_PATTERN.exec(context.text.substring(result.index + result.text.length));
    if (!secondMatch) {
      if (result.text.match(/^\d+$/)) {
        return null;
      }
      return result;
    }
    let endMoment = new Date(startMoment.getTime());
    if (secondMatch[DAY_GROUP_1] || secondMatch[DAY_GROUP_3]) {
      endMoment = new Date(context.reference.instant.getTime());
    }
    result.end = context.createParsingComponents();
    if (secondMatch[DAY_GROUP_1]) {
      const day1 = secondMatch[DAY_GROUP_1];
      if (day1 == "\u660E") {
        if (context.reference.instant.getHours() > 1) {
          endMoment.setDate(endMoment.getDate() + 1);
        }
      } else if (day1 == "\u6628") {
        endMoment.setDate(endMoment.getDate() - 1);
      } else if (day1 == "\u524D") {
        endMoment.setDate(endMoment.getDate() - 2);
      } else if (day1 == "\u5927\u524D") {
        endMoment.setDate(endMoment.getDate() - 3);
      } else if (day1 == "\u540E") {
        endMoment.setDate(endMoment.getDate() + 2);
      } else if (day1 == "\u5927\u540E") {
        endMoment.setDate(endMoment.getDate() + 3);
      }
      result.end.assign("day", endMoment.getDate());
      result.end.assign("month", endMoment.getMonth() + 1);
      result.end.assign("year", endMoment.getFullYear());
    } else if (secondMatch[DAY_GROUP_3]) {
      const day3 = secondMatch[DAY_GROUP_3];
      if (day3 == "\u660E") {
        endMoment.setDate(endMoment.getDate() + 1);
      } else if (day3 == "\u6628") {
        endMoment.setDate(endMoment.getDate() - 1);
      } else if (day3 == "\u524D") {
        endMoment.setDate(endMoment.getDate() - 2);
      } else if (day3 == "\u5927\u524D") {
        endMoment.setDate(endMoment.getDate() - 3);
      } else if (day3 == "\u540E") {
        endMoment.setDate(endMoment.getDate() + 2);
      } else if (day3 == "\u5927\u540E") {
        endMoment.setDate(endMoment.getDate() + 3);
      }
      result.end.assign("day", endMoment.getDate());
      result.end.assign("month", endMoment.getMonth() + 1);
      result.end.assign("year", endMoment.getFullYear());
    } else {
      result.end.imply("day", endMoment.getDate());
      result.end.imply("month", endMoment.getMonth() + 1);
      result.end.imply("year", endMoment.getFullYear());
    }
    hour = 0;
    minute = 0;
    meridiem = -1;
    if (secondMatch[SECOND_GROUP2]) {
      let second = parseInt(secondMatch[SECOND_GROUP2]);
      if (isNaN(second)) {
        second = zhStringToNumber(secondMatch[SECOND_GROUP2]);
      }
      if (second >= 60)
        return null;
      result.end.assign("second", second);
    }
    hour = parseInt(secondMatch[HOUR_GROUP2]);
    if (isNaN(hour)) {
      hour = zhStringToNumber(secondMatch[HOUR_GROUP2]);
    }
    if (secondMatch[MINUTE_GROUP2]) {
      if (secondMatch[MINUTE_GROUP2] == "\u534A") {
        minute = 30;
      } else if (secondMatch[MINUTE_GROUP2] == "\u6B63" || secondMatch[MINUTE_GROUP2] == "\u6574") {
        minute = 0;
      } else {
        minute = parseInt(secondMatch[MINUTE_GROUP2]);
        if (isNaN(minute)) {
          minute = zhStringToNumber(secondMatch[MINUTE_GROUP2]);
        }
      }
    } else if (hour > 100) {
      minute = hour % 100;
      hour = Math.floor(hour / 100);
    }
    if (minute >= 60) {
      return null;
    }
    if (hour > 24) {
      return null;
    }
    if (hour >= 12) {
      meridiem = 1;
    }
    if (secondMatch[AM_PM_HOUR_GROUP2]) {
      if (hour > 12)
        return null;
      const ampm = secondMatch[AM_PM_HOUR_GROUP2][0].toLowerCase();
      if (ampm == "a") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      }
      if (ampm == "p") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
      if (!result.start.isCertain("meridiem")) {
        if (meridiem == 0) {
          result.start.imply("meridiem", 0);
          if (result.start.get("hour") == 12) {
            result.start.assign("hour", 0);
          }
        } else {
          result.start.imply("meridiem", 1);
          if (result.start.get("hour") != 12) {
            result.start.assign("hour", result.start.get("hour") + 12);
          }
        }
      }
    } else if (secondMatch[ZH_AM_PM_HOUR_GROUP_1]) {
      const zhAMPMString1 = secondMatch[ZH_AM_PM_HOUR_GROUP_1];
      const zhAMPM1 = zhAMPMString1[0];
      if (zhAMPM1 == "\u65E9") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM1 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (secondMatch[ZH_AM_PM_HOUR_GROUP_2]) {
      const zhAMPMString2 = secondMatch[ZH_AM_PM_HOUR_GROUP_2];
      const zhAMPM2 = zhAMPMString2[0];
      if (zhAMPM2 == "\u4E0A" || zhAMPM2 == "\u65E9" || zhAMPM2 == "\u51CC") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM2 == "\u4E0B" || zhAMPM2 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (secondMatch[ZH_AM_PM_HOUR_GROUP_3]) {
      const zhAMPMString3 = secondMatch[ZH_AM_PM_HOUR_GROUP_3];
      const zhAMPM3 = zhAMPMString3[0];
      if (zhAMPM3 == "\u4E0A" || zhAMPM3 == "\u65E9" || zhAMPM3 == "\u51CC") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM3 == "\u4E0B" || zhAMPM3 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    }
    result.text = result.text + secondMatch[0];
    result.end.assign("hour", hour);
    result.end.assign("minute", minute);
    if (meridiem >= 0) {
      result.end.assign("meridiem", meridiem);
    } else {
      const startAtPM = result.start.isCertain("meridiem") && result.start.get("meridiem") == 1;
      if (startAtPM && result.start.get("hour") > hour) {
        result.end.imply("meridiem", 0);
      } else if (hour > 12) {
        result.end.imply("meridiem", 1);
      }
    }
    if (result.end.date().getTime() < result.start.date().getTime()) {
      result.end.imply("day", result.end.get("day") + 1);
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hans/parsers/ZHHansWeekdayParser.js
var PATTERN18 = new RegExp("(?:\u661F\u671F|\u793C\u62DC|\u5468)(?<weekday>" + Object.keys(WEEKDAY_OFFSET).join("|") + ")");
var ZHHansWeekdayParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHansWeekdayParser");
  }
  innerPattern() {
    return PATTERN18;
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    const dayOfWeek = match.groups.weekday;
    const offset = WEEKDAY_OFFSET[dayOfWeek];
    if (offset === void 0)
      return null;
    const date = new Date(context.refDate.getTime());
    const startMomentFixed = false;
    const refOffset = date.getDay();
    let diff = offset - refOffset;
    if (Math.abs(diff - 7) < Math.abs(diff)) {
      diff -= 7;
    }
    if (Math.abs(diff + 7) < Math.abs(diff)) {
      diff += 7;
    }
    date.setDate(date.getDate() + diff);
    result.start.assign("weekday", offset);
    if (startMomentFixed) {
      result.start.assign("day", date.getDate());
      result.start.assign("month", date.getMonth() + 1);
      result.start.assign("year", date.getFullYear());
    } else {
      result.start.imply("day", date.getDate());
      result.start.imply("month", date.getMonth() + 1);
      result.start.imply("year", date.getFullYear());
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/parsers/ZHHantCasualDateParser.js
var NOW_GROUP = 1;
var DAY_GROUP_12 = 2;
var TIME_GROUP_1 = 3;
var TIME_GROUP_2 = 4;
var DAY_GROUP_32 = 5;
var TIME_GROUP_3 = 6;
var ZHHantCasualDateParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHantCasualDateParser");
  }
  innerPattern(context) {
    return new RegExp("(\u800C\u5BB6|\u7ACB(?:\u523B|\u5373)|\u5373\u523B)|(\u4ECA|\u660E|\u524D|\u5927\u524D|\u5F8C|\u5927\u5F8C|\u807D|\u6628|\u5C0B|\u7434)(\u65E9|\u671D|\u665A)|(\u4E0A(?:\u5348|\u665D)|\u671D(?:\u65E9)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348|\u665D)|\u664F(?:\u665D)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668))|(\u4ECA|\u660E|\u524D|\u5927\u524D|\u5F8C|\u5927\u5F8C|\u807D|\u6628|\u5C0B|\u7434)(?:\u65E5|\u5929)(?:[\\s|,|\uFF0C]*)(?:(\u4E0A(?:\u5348|\u665D)|\u671D(?:\u65E9)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348|\u665D)|\u664F(?:\u665D)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668)))?", "i");
  }
  innerExtract(context, match) {
    const index = match.index;
    const result = context.createParsingResult(index, match[0]);
    const refDate = context.refDate;
    let date = new Date(refDate.getTime());
    if (match[NOW_GROUP]) {
      result.start.imply("hour", refDate.getHours());
      result.start.imply("minute", refDate.getMinutes());
      result.start.imply("second", refDate.getSeconds());
      result.start.imply("millisecond", refDate.getMilliseconds());
    } else if (match[DAY_GROUP_12]) {
      const day1 = match[DAY_GROUP_12];
      const time1 = match[TIME_GROUP_1];
      if (day1 == "\u660E" || day1 == "\u807D") {
        if (refDate.getHours() > 1) {
          date.setDate(date.getDate() + 1);
        }
      } else if (day1 == "\u6628" || day1 == "\u5C0B" || day1 == "\u7434") {
        date.setDate(date.getDate() - 1);
      } else if (day1 == "\u524D") {
        date.setDate(date.getDate() - 2);
      } else if (day1 == "\u5927\u524D") {
        date.setDate(date.getDate() - 3);
      } else if (day1 == "\u5F8C") {
        date.setDate(date.getDate() + 2);
      } else if (day1 == "\u5927\u5F8C") {
        date.setDate(date.getDate() + 3);
      }
      if (time1 == "\u65E9" || time1 == "\u671D") {
        result.start.imply("hour", 6);
      } else if (time1 == "\u665A") {
        result.start.imply("hour", 22);
        result.start.imply("meridiem", 1);
      }
    } else if (match[TIME_GROUP_2]) {
      const timeString2 = match[TIME_GROUP_2];
      const time2 = timeString2[0];
      if (time2 == "\u65E9" || time2 == "\u671D" || time2 == "\u4E0A") {
        result.start.imply("hour", 6);
      } else if (time2 == "\u4E0B" || time2 == "\u664F") {
        result.start.imply("hour", 15);
        result.start.imply("meridiem", 1);
      } else if (time2 == "\u4E2D") {
        result.start.imply("hour", 12);
        result.start.imply("meridiem", 1);
      } else if (time2 == "\u591C" || time2 == "\u665A") {
        result.start.imply("hour", 22);
        result.start.imply("meridiem", 1);
      } else if (time2 == "\u51CC") {
        result.start.imply("hour", 0);
      }
    } else if (match[DAY_GROUP_32]) {
      const day3 = match[DAY_GROUP_32];
      if (day3 == "\u660E" || day3 == "\u807D") {
        if (refDate.getHours() > 1) {
          date.setDate(date.getDate() + 1);
        }
      } else if (day3 == "\u6628" || day3 == "\u5C0B" || day3 == "\u7434") {
        date.setDate(date.getDate() - 1);
      } else if (day3 == "\u524D") {
        date.setDate(date.getDate() - 2);
      } else if (day3 == "\u5927\u524D") {
        date.setDate(date.getDate() - 3);
      } else if (day3 == "\u5F8C") {
        date.setDate(date.getDate() + 2);
      } else if (day3 == "\u5927\u5F8C") {
        date.setDate(date.getDate() + 3);
      }
      const timeString3 = match[TIME_GROUP_3];
      if (timeString3) {
        const time3 = timeString3[0];
        if (time3 == "\u65E9" || time3 == "\u671D" || time3 == "\u4E0A") {
          result.start.imply("hour", 6);
        } else if (time3 == "\u4E0B" || time3 == "\u664F") {
          result.start.imply("hour", 15);
          result.start.imply("meridiem", 1);
        } else if (time3 == "\u4E2D") {
          result.start.imply("hour", 12);
          result.start.imply("meridiem", 1);
        } else if (time3 == "\u591C" || time3 == "\u665A") {
          result.start.imply("hour", 22);
          result.start.imply("meridiem", 1);
        } else if (time3 == "\u51CC") {
          result.start.imply("hour", 0);
        }
      }
    }
    result.start.assign("day", date.getDate());
    result.start.assign("month", date.getMonth() + 1);
    result.start.assign("year", date.getFullYear());
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/constants.js
var NUMBER2 = {
  "\u96F6": 0,
  "\u4E00": 1,
  "\u4E8C": 2,
  "\u5169": 2,
  "\u4E09": 3,
  "\u56DB": 4,
  "\u4E94": 5,
  "\u516D": 6,
  "\u4E03": 7,
  "\u516B": 8,
  "\u4E5D": 9,
  "\u5341": 10,
  "\u5EFF": 20,
  "\u5345": 30
};
var WEEKDAY_OFFSET2 = {
  "\u5929": 0,
  "\u65E5": 0,
  "\u4E00": 1,
  "\u4E8C": 2,
  "\u4E09": 3,
  "\u56DB": 4,
  "\u4E94": 5,
  "\u516D": 6
};
function zhStringToNumber2(text2) {
  let number = 0;
  for (let i = 0; i < text2.length; i++) {
    const char = text2[i];
    if (char === "\u5341") {
      number = number === 0 ? NUMBER2[char] : number * NUMBER2[char];
    } else {
      number += NUMBER2[char];
    }
  }
  return number;
}
__name(zhStringToNumber2, "zhStringToNumber");
function zhStringToYear2(text2) {
  let string = "";
  for (let i = 0; i < text2.length; i++) {
    const char = text2[i];
    string = string + NUMBER2[char];
  }
  return parseInt(string);
}
__name(zhStringToYear2, "zhStringToYear");

// node_modules/chrono-node/dist/esm/locales/zh/hant/parsers/ZHHantDateParser.js
var YEAR_GROUP9 = 1;
var MONTH_GROUP3 = 2;
var DAY_GROUP2 = 3;
var ZHHantDateParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHantDateParser");
  }
  innerPattern() {
    return new RegExp("(\\d{2,4}|[" + Object.keys(NUMBER2).join("") + "]{4}|[" + Object.keys(NUMBER2).join("") + "]{2})?(?:\\s*)(?:\u5E74)?(?:[\\s|,|\uFF0C]*)(\\d{1,2}|[" + Object.keys(NUMBER2).join("") + "]{1,2})(?:\\s*)(?:\u6708)(?:\\s*)(\\d{1,2}|[" + Object.keys(NUMBER2).join("") + "]{1,2})?(?:\\s*)(?:\u65E5|\u865F)?");
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    let month = parseInt(match[MONTH_GROUP3]);
    if (isNaN(month))
      month = zhStringToNumber2(match[MONTH_GROUP3]);
    result.start.assign("month", month);
    if (match[DAY_GROUP2]) {
      let day = parseInt(match[DAY_GROUP2]);
      if (isNaN(day))
        day = zhStringToNumber2(match[DAY_GROUP2]);
      result.start.assign("day", day);
    } else {
      result.start.imply("day", context.refDate.getDate());
    }
    if (match[YEAR_GROUP9]) {
      let year = parseInt(match[YEAR_GROUP9]);
      if (isNaN(year))
        year = zhStringToYear2(match[YEAR_GROUP9]);
      result.start.assign("year", year);
    } else {
      result.start.imply("year", context.refDate.getFullYear());
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/parsers/ZHHantDeadlineFormatParser.js
var PATTERN19 = new RegExp("(\\d+|[" + Object.keys(NUMBER2).join("") + "]+|\u534A|\u5E7E)(?:\\s*)(?:\u500B)?(\u79D2(?:\u9418)?|\u5206\u9418|\u5C0F\u6642|\u9418|\u65E5|\u5929|\u661F\u671F|\u79AE\u62DC|\u6708|\u5E74)(?:(?:\u4E4B|\u904E)?\u5F8C|(?:\u4E4B)?\u5167)", "i");
var NUMBER_GROUP2 = 1;
var UNIT_GROUP2 = 2;
var ZHHantDeadlineFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHantDeadlineFormatParser");
  }
  innerPattern() {
    return PATTERN19;
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    let number = parseInt(match[NUMBER_GROUP2]);
    if (isNaN(number)) {
      number = zhStringToNumber2(match[NUMBER_GROUP2]);
    }
    if (isNaN(number)) {
      const string = match[NUMBER_GROUP2];
      if (string === "\u5E7E") {
        number = 3;
      } else if (string === "\u534A") {
        number = 0.5;
      } else {
        return null;
      }
    }
    const duration = {};
    const unit = match[UNIT_GROUP2];
    const unitAbbr = unit[0];
    if (unitAbbr.match(/[日天星禮月年]/)) {
      if (unitAbbr == "\u65E5" || unitAbbr == "\u5929") {
        duration.day = number;
      } else if (unitAbbr == "\u661F" || unitAbbr == "\u79AE") {
        duration.week = number;
      } else if (unitAbbr == "\u6708") {
        duration.month = number;
      } else if (unitAbbr == "\u5E74") {
        duration.year = number;
      }
      const date2 = addDuration(context.refDate, duration);
      result.start.assign("year", date2.getFullYear());
      result.start.assign("month", date2.getMonth() + 1);
      result.start.assign("day", date2.getDate());
      return result;
    }
    if (unitAbbr == "\u79D2") {
      duration.second = number;
    } else if (unitAbbr == "\u5206") {
      duration.minute = number;
    } else if (unitAbbr == "\u5C0F" || unitAbbr == "\u9418") {
      duration.hour = number;
    }
    const date = addDuration(context.refDate, duration);
    result.start.imply("year", date.getFullYear());
    result.start.imply("month", date.getMonth() + 1);
    result.start.imply("day", date.getDate());
    result.start.assign("hour", date.getHours());
    result.start.assign("minute", date.getMinutes());
    result.start.assign("second", date.getSeconds());
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/parsers/ZHHantRelationWeekdayParser.js
var PATTERN20 = new RegExp("(?<prefix>\u4E0A|\u4ECA|\u4E0B|\u9019|\u5462)(?:\u500B)?(?:\u661F\u671F|\u79AE\u62DC|\u9031)(?<weekday>" + Object.keys(WEEKDAY_OFFSET2).join("|") + ")");
var ZHHantRelationWeekdayParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHantRelationWeekdayParser");
  }
  innerPattern() {
    return PATTERN20;
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    const dayOfWeek = match.groups.weekday;
    const offset = WEEKDAY_OFFSET2[dayOfWeek];
    if (offset === void 0)
      return null;
    let modifier = null;
    const prefix = match.groups.prefix;
    if (prefix == "\u4E0A") {
      modifier = "last";
    } else if (prefix == "\u4E0B") {
      modifier = "next";
    } else if (prefix == "\u4ECA" || prefix == "\u9019" || prefix == "\u5462") {
      modifier = "this";
    }
    const date = new Date(context.refDate.getTime());
    let startMomentFixed = false;
    const refOffset = date.getDay();
    if (modifier == "last" || modifier == "past") {
      date.setDate(date.getDate() + (offset - 7 - refOffset));
      startMomentFixed = true;
    } else if (modifier == "next") {
      date.setDate(date.getDate() + (offset + 7 - refOffset));
      startMomentFixed = true;
    } else if (modifier == "this") {
      date.setDate(date.getDate() + (offset - refOffset));
    } else {
      let diff = offset - refOffset;
      if (Math.abs(diff - 7) < Math.abs(diff)) {
        diff -= 7;
      }
      if (Math.abs(diff + 7) < Math.abs(diff)) {
        diff += 7;
      }
      date.setDate(date.getDate() + diff);
    }
    result.start.assign("weekday", offset);
    if (startMomentFixed) {
      result.start.assign("day", date.getDate());
      result.start.assign("month", date.getMonth() + 1);
      result.start.assign("year", date.getFullYear());
    } else {
      result.start.imply("day", date.getDate());
      result.start.imply("month", date.getMonth() + 1);
      result.start.imply("year", date.getFullYear());
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/parsers/ZHHantTimeExpressionParser.js
var FIRST_REG_PATTERN2 = new RegExp("(?:\u7531|\u5F9E|\u81EA)?(?:(\u4ECA|\u660E|\u524D|\u5927\u524D|\u5F8C|\u5927\u5F8C|\u807D|\u6628|\u5C0B|\u7434)(\u65E9|\u671D|\u665A)|(\u4E0A(?:\u5348|\u665D)|\u671D(?:\u65E9)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348|\u665D)|\u664F(?:\u665D)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668))|(\u4ECA|\u660E|\u524D|\u5927\u524D|\u5F8C|\u5927\u5F8C|\u807D|\u6628|\u5C0B|\u7434)(?:\u65E5|\u5929)(?:[\\s,\uFF0C]*)(?:(\u4E0A(?:\u5348|\u665D)|\u671D(?:\u65E9)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348|\u665D)|\u664F(?:\u665D)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668)))?)?(?:[\\s,\uFF0C]*)(?:(\\d+|[" + Object.keys(NUMBER2).join("") + "]+)(?:\\s*)(?:\u9EDE|\u6642|:|\uFF1A)(?:\\s*)(\\d+|\u534A|\u6B63|\u6574|[" + Object.keys(NUMBER2).join("") + "]+)?(?:\\s*)(?:\u5206|:|\uFF1A)?(?:\\s*)(\\d+|[" + Object.keys(NUMBER2).join("") + "]+)?(?:\\s*)(?:\u79D2)?)(?:\\s*(A.M.|P.M.|AM?|PM?))?", "i");
var SECOND_REG_PATTERN2 = new RegExp("(?:^\\s*(?:\u5230|\u81F3|\\-|\\\u2013|\\~|\\\u301C)\\s*)(?:(\u4ECA|\u660E|\u524D|\u5927\u524D|\u5F8C|\u5927\u5F8C|\u807D|\u6628|\u5C0B|\u7434)(\u65E9|\u671D|\u665A)|(\u4E0A(?:\u5348|\u665D)|\u671D(?:\u65E9)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348|\u665D)|\u664F(?:\u665D)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668))|(\u4ECA|\u660E|\u524D|\u5927\u524D|\u5F8C|\u5927\u5F8C|\u807D|\u6628|\u5C0B|\u7434)(?:\u65E5|\u5929)(?:[\\s,\uFF0C]*)(?:(\u4E0A(?:\u5348|\u665D)|\u671D(?:\u65E9)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348|\u665D)|\u664F(?:\u665D)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668)))?)?(?:[\\s,\uFF0C]*)(?:(\\d+|[" + Object.keys(NUMBER2).join("") + "]+)(?:\\s*)(?:\u9EDE|\u6642|:|\uFF1A)(?:\\s*)(\\d+|\u534A|\u6B63|\u6574|[" + Object.keys(NUMBER2).join("") + "]+)?(?:\\s*)(?:\u5206|:|\uFF1A)?(?:\\s*)(\\d+|[" + Object.keys(NUMBER2).join("") + "]+)?(?:\\s*)(?:\u79D2)?)(?:\\s*(A.M.|P.M.|AM?|PM?))?", "i");
var DAY_GROUP_13 = 1;
var ZH_AM_PM_HOUR_GROUP_12 = 2;
var ZH_AM_PM_HOUR_GROUP_22 = 3;
var DAY_GROUP_33 = 4;
var ZH_AM_PM_HOUR_GROUP_32 = 5;
var HOUR_GROUP3 = 6;
var MINUTE_GROUP3 = 7;
var SECOND_GROUP3 = 8;
var AM_PM_HOUR_GROUP3 = 9;
var ZHHantTimeExpressionParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHantTimeExpressionParser");
  }
  patternLeftBoundary() {
    return "()";
  }
  innerPattern() {
    return FIRST_REG_PATTERN2;
  }
  innerExtract(context, match) {
    if (match.index > 0 && context.text[match.index - 1].match(/\w/)) {
      return null;
    }
    const result = context.createParsingResult(match.index, match[0]);
    const startMoment = new Date(context.reference.instant.getTime());
    if (match[DAY_GROUP_13]) {
      const day1 = match[DAY_GROUP_13];
      if (day1 == "\u660E" || day1 == "\u807D") {
        if (context.refDate.getHours() > 1) {
          startMoment.setDate(startMoment.getDate() + 1);
        }
      } else if (day1 == "\u6628" || day1 == "\u5C0B" || day1 == "\u7434") {
        startMoment.setDate(startMoment.getDate() - 1);
      } else if (day1 == "\u524D") {
        startMoment.setDate(startMoment.getDate() - 2);
      } else if (day1 == "\u5927\u524D") {
        startMoment.setDate(startMoment.getDate() - 3);
      } else if (day1 == "\u5F8C") {
        startMoment.setDate(startMoment.getDate() + 2);
      } else if (day1 == "\u5927\u5F8C") {
        startMoment.setDate(startMoment.getDate() + 3);
      }
      result.start.assign("day", startMoment.getDate());
      result.start.assign("month", startMoment.getMonth() + 1);
      result.start.assign("year", startMoment.getFullYear());
    } else if (match[DAY_GROUP_33]) {
      const day3 = match[DAY_GROUP_33];
      if (day3 == "\u660E" || day3 == "\u807D") {
        startMoment.setDate(startMoment.getDate() + 1);
      } else if (day3 == "\u6628" || day3 == "\u5C0B" || day3 == "\u7434") {
        startMoment.setDate(startMoment.getDate() - 1);
      } else if (day3 == "\u524D") {
        startMoment.setDate(startMoment.getDate() - 2);
      } else if (day3 == "\u5927\u524D") {
        startMoment.setDate(startMoment.getDate() - 3);
      } else if (day3 == "\u5F8C") {
        startMoment.setDate(startMoment.getDate() + 2);
      } else if (day3 == "\u5927\u5F8C") {
        startMoment.setDate(startMoment.getDate() + 3);
      }
      result.start.assign("day", startMoment.getDate());
      result.start.assign("month", startMoment.getMonth() + 1);
      result.start.assign("year", startMoment.getFullYear());
    } else {
      result.start.imply("day", startMoment.getDate());
      result.start.imply("month", startMoment.getMonth() + 1);
      result.start.imply("year", startMoment.getFullYear());
    }
    let hour = 0;
    let minute = 0;
    let meridiem = -1;
    if (match[SECOND_GROUP3]) {
      var second = parseInt(match[SECOND_GROUP3]);
      if (isNaN(second)) {
        second = zhStringToNumber2(match[SECOND_GROUP3]);
      }
      if (second >= 60)
        return null;
      result.start.assign("second", second);
    }
    hour = parseInt(match[HOUR_GROUP3]);
    if (isNaN(hour)) {
      hour = zhStringToNumber2(match[HOUR_GROUP3]);
    }
    if (match[MINUTE_GROUP3]) {
      if (match[MINUTE_GROUP3] == "\u534A") {
        minute = 30;
      } else if (match[MINUTE_GROUP3] == "\u6B63" || match[MINUTE_GROUP3] == "\u6574") {
        minute = 0;
      } else {
        minute = parseInt(match[MINUTE_GROUP3]);
        if (isNaN(minute)) {
          minute = zhStringToNumber2(match[MINUTE_GROUP3]);
        }
      }
    } else if (hour > 100) {
      minute = hour % 100;
      hour = Math.floor(hour / 100);
    }
    if (minute >= 60) {
      return null;
    }
    if (hour > 24) {
      return null;
    }
    if (hour >= 12) {
      meridiem = 1;
    }
    if (match[AM_PM_HOUR_GROUP3]) {
      if (hour > 12)
        return null;
      var ampm = match[AM_PM_HOUR_GROUP3][0].toLowerCase();
      if (ampm == "a") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      }
      if (ampm == "p") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (match[ZH_AM_PM_HOUR_GROUP_12]) {
      var zhAMPMString1 = match[ZH_AM_PM_HOUR_GROUP_12];
      var zhAMPM1 = zhAMPMString1[0];
      if (zhAMPM1 == "\u671D" || zhAMPM1 == "\u65E9") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM1 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (match[ZH_AM_PM_HOUR_GROUP_22]) {
      var zhAMPMString2 = match[ZH_AM_PM_HOUR_GROUP_22];
      var zhAMPM2 = zhAMPMString2[0];
      if (zhAMPM2 == "\u4E0A" || zhAMPM2 == "\u671D" || zhAMPM2 == "\u65E9" || zhAMPM2 == "\u51CC") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM2 == "\u4E0B" || zhAMPM2 == "\u664F" || zhAMPM2 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (match[ZH_AM_PM_HOUR_GROUP_32]) {
      var zhAMPMString3 = match[ZH_AM_PM_HOUR_GROUP_32];
      var zhAMPM3 = zhAMPMString3[0];
      if (zhAMPM3 == "\u4E0A" || zhAMPM3 == "\u671D" || zhAMPM3 == "\u65E9" || zhAMPM3 == "\u51CC") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM3 == "\u4E0B" || zhAMPM3 == "\u664F" || zhAMPM3 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    }
    result.start.assign("hour", hour);
    result.start.assign("minute", minute);
    if (meridiem >= 0) {
      result.start.assign("meridiem", meridiem);
    } else {
      if (hour < 12) {
        result.start.imply("meridiem", 0);
      } else {
        result.start.imply("meridiem", 1);
      }
    }
    const secondMatch = SECOND_REG_PATTERN2.exec(context.text.substring(result.index + result.text.length));
    if (!secondMatch) {
      if (result.text.match(/^\d+$/)) {
        return null;
      }
      return result;
    }
    let endMoment = new Date(startMoment.getTime());
    if (secondMatch[DAY_GROUP_13] || secondMatch[DAY_GROUP_33]) {
      endMoment = new Date(context.reference.instant.getTime());
    }
    result.end = context.createParsingComponents();
    if (secondMatch[DAY_GROUP_13]) {
      const day1 = secondMatch[DAY_GROUP_13];
      if (day1 == "\u660E" || day1 == "\u807D") {
        if (context.refDate.getHours() > 1) {
          endMoment.setDate(endMoment.getDate() + 1);
        }
      } else if (day1 == "\u6628" || day1 == "\u5C0B" || day1 == "\u7434") {
        endMoment.setDate(endMoment.getDate() - 1);
      } else if (day1 == "\u524D") {
        endMoment.setDate(endMoment.getDate() - 2);
      } else if (day1 == "\u5927\u524D") {
        endMoment.setDate(endMoment.getDate() - 3);
      } else if (day1 == "\u5F8C") {
        endMoment.setDate(endMoment.getDate() + 2);
      } else if (day1 == "\u5927\u5F8C") {
        endMoment.setDate(endMoment.getDate() + 3);
      }
      result.end.assign("day", endMoment.getDate());
      result.end.assign("month", endMoment.getMonth() + 1);
      result.end.assign("year", endMoment.getFullYear());
    } else if (secondMatch[DAY_GROUP_33]) {
      const day3 = secondMatch[DAY_GROUP_33];
      if (day3 == "\u660E" || day3 == "\u807D") {
        endMoment.setDate(endMoment.getDate() + 1);
      } else if (day3 == "\u6628" || day3 == "\u5C0B" || day3 == "\u7434") {
        endMoment.setDate(endMoment.getDate() - 1);
      } else if (day3 == "\u524D") {
        endMoment.setDate(endMoment.getDate() - 2);
      } else if (day3 == "\u5927\u524D") {
        endMoment.setDate(endMoment.getDate() - 3);
      } else if (day3 == "\u5F8C") {
        endMoment.setDate(endMoment.getDate() + 2);
      } else if (day3 == "\u5927\u5F8C") {
        endMoment.setDate(endMoment.getDate() + 3);
      }
      result.end.assign("day", endMoment.getDate());
      result.end.assign("month", endMoment.getMonth() + 1);
      result.end.assign("year", endMoment.getFullYear());
    } else {
      result.end.imply("day", endMoment.getDate());
      result.end.imply("month", endMoment.getMonth() + 1);
      result.end.imply("year", endMoment.getFullYear());
    }
    hour = 0;
    minute = 0;
    meridiem = -1;
    if (secondMatch[SECOND_GROUP3]) {
      let second2 = parseInt(secondMatch[SECOND_GROUP3]);
      if (isNaN(second2)) {
        second2 = zhStringToNumber2(secondMatch[SECOND_GROUP3]);
      }
      if (second2 >= 60)
        return null;
      result.end.assign("second", second2);
    }
    hour = parseInt(secondMatch[HOUR_GROUP3]);
    if (isNaN(hour)) {
      hour = zhStringToNumber2(secondMatch[HOUR_GROUP3]);
    }
    if (secondMatch[MINUTE_GROUP3]) {
      if (secondMatch[MINUTE_GROUP3] == "\u534A") {
        minute = 30;
      } else if (secondMatch[MINUTE_GROUP3] == "\u6B63" || secondMatch[MINUTE_GROUP3] == "\u6574") {
        minute = 0;
      } else {
        minute = parseInt(secondMatch[MINUTE_GROUP3]);
        if (isNaN(minute)) {
          minute = zhStringToNumber2(secondMatch[MINUTE_GROUP3]);
        }
      }
    } else if (hour > 100) {
      minute = hour % 100;
      hour = Math.floor(hour / 100);
    }
    if (minute >= 60) {
      return null;
    }
    if (hour > 24) {
      return null;
    }
    if (hour >= 12) {
      meridiem = 1;
    }
    if (secondMatch[AM_PM_HOUR_GROUP3]) {
      if (hour > 12)
        return null;
      var ampm = secondMatch[AM_PM_HOUR_GROUP3][0].toLowerCase();
      if (ampm == "a") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      }
      if (ampm == "p") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
      if (!result.start.isCertain("meridiem")) {
        if (meridiem == 0) {
          result.start.imply("meridiem", 0);
          if (result.start.get("hour") == 12) {
            result.start.assign("hour", 0);
          }
        } else {
          result.start.imply("meridiem", 1);
          if (result.start.get("hour") != 12) {
            result.start.assign("hour", result.start.get("hour") + 12);
          }
        }
      }
    } else if (secondMatch[ZH_AM_PM_HOUR_GROUP_12]) {
      const zhAMPMString12 = secondMatch[ZH_AM_PM_HOUR_GROUP_12];
      var zhAMPM1 = zhAMPMString12[0];
      if (zhAMPM1 == "\u671D" || zhAMPM1 == "\u65E9") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM1 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (secondMatch[ZH_AM_PM_HOUR_GROUP_22]) {
      const zhAMPMString22 = secondMatch[ZH_AM_PM_HOUR_GROUP_22];
      var zhAMPM2 = zhAMPMString22[0];
      if (zhAMPM2 == "\u4E0A" || zhAMPM2 == "\u671D" || zhAMPM2 == "\u65E9" || zhAMPM2 == "\u51CC") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM2 == "\u4E0B" || zhAMPM2 == "\u664F" || zhAMPM2 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    } else if (secondMatch[ZH_AM_PM_HOUR_GROUP_32]) {
      const zhAMPMString32 = secondMatch[ZH_AM_PM_HOUR_GROUP_32];
      var zhAMPM3 = zhAMPMString32[0];
      if (zhAMPM3 == "\u4E0A" || zhAMPM3 == "\u671D" || zhAMPM3 == "\u65E9" || zhAMPM3 == "\u51CC") {
        meridiem = 0;
        if (hour == 12)
          hour = 0;
      } else if (zhAMPM3 == "\u4E0B" || zhAMPM3 == "\u664F" || zhAMPM3 == "\u665A") {
        meridiem = 1;
        if (hour != 12)
          hour += 12;
      }
    }
    result.text = result.text + secondMatch[0];
    result.end.assign("hour", hour);
    result.end.assign("minute", minute);
    if (meridiem >= 0) {
      result.end.assign("meridiem", meridiem);
    } else {
      const startAtPM = result.start.isCertain("meridiem") && result.start.get("meridiem") == 1;
      if (startAtPM && result.start.get("hour") > hour) {
        result.end.imply("meridiem", 0);
      } else if (hour > 12) {
        result.end.imply("meridiem", 1);
      }
    }
    if (result.end.date().getTime() < result.start.date().getTime()) {
      result.end.imply("day", result.end.get("day") + 1);
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/parsers/ZHHantWeekdayParser.js
var PATTERN21 = new RegExp("(?:\u661F\u671F|\u79AE\u62DC|\u9031)(?<weekday>" + Object.keys(WEEKDAY_OFFSET2).join("|") + ")");
var ZHHantWeekdayParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHantWeekdayParser");
  }
  innerPattern() {
    return PATTERN21;
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    const dayOfWeek = match.groups.weekday;
    const offset = WEEKDAY_OFFSET2[dayOfWeek];
    if (offset === void 0)
      return null;
    const date = new Date(context.refDate.getTime());
    const startMomentFixed = false;
    const refOffset = date.getDay();
    let diff = offset - refOffset;
    if (Math.abs(diff - 7) < Math.abs(diff)) {
      diff -= 7;
    }
    if (Math.abs(diff + 7) < Math.abs(diff)) {
      diff += 7;
    }
    date.setDate(date.getDate() + diff);
    result.start.assign("weekday", offset);
    if (startMomentFixed) {
      result.start.assign("day", date.getDate());
      result.start.assign("month", date.getMonth() + 1);
      result.start.assign("year", date.getFullYear());
    } else {
      result.start.imply("day", date.getDate());
      result.start.imply("month", date.getMonth() + 1);
      result.start.imply("year", date.getFullYear());
    }
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/refiners/ZHHantMergeDateRangeRefiner.js
var ZHHantMergeDateRangeRefiner = class extends AbstractMergeDateRangeRefiner {
  static {
    __name(this, "ZHHantMergeDateRangeRefiner");
  }
  patternBetween() {
    return /^\s*(至|到|\-|\~|～|－|ー)\s*$/i;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/refiners/ZHHantMergeDateTimeRefiner.js
var ZHHantMergeDateTimeRefiner = class extends AbstractMergeDateTimeRefiner {
  static {
    __name(this, "ZHHantMergeDateTimeRefiner");
  }
  patternBetween() {
    return /^\s*$/i;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/index.js
var hant_exports = {};
__export(hant_exports, {
  Chrono: () => Chrono,
  Meridiem: () => Meridiem,
  ParsingComponents: () => ParsingComponents,
  ParsingResult: () => ParsingResult,
  ReferenceWithTimezone: () => ReferenceWithTimezone,
  Weekday: () => Weekday,
  casual: () => casual,
  createCasualConfiguration: () => createCasualConfiguration,
  createConfiguration: () => createConfiguration,
  hant: () => hant,
  parse: () => parse,
  parseDate: () => parseDate,
  strict: () => strict
});

// node_modules/chrono-node/dist/esm/locales/zh/hant/parsers/ZHHantAgoFormatParser.js
var PATTERN22 = new RegExp("(\\d+|[" + Object.keys(NUMBER2).join("") + "]+|\u534A|\u5E7E)(?:\\s*)(?:\u500B)?(\u79D2(?:\u9418)?|\u5206\u9418|\u5C0F\u6642|\u9418|\u65E5|\u5929|\u661F\u671F|\u79AE\u62DC|\u6708|\u5E74)(?:\u4E4B)?\u524D", "i");
var NUMBER_GROUP3 = 1;
var UNIT_GROUP3 = 2;
var ZHHantAgoFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHantAgoFormatParser");
  }
  innerPattern() {
    return PATTERN22;
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    let number = parseInt(match[NUMBER_GROUP3]);
    if (isNaN(number)) {
      number = zhStringToNumber2(match[NUMBER_GROUP3]);
    }
    if (isNaN(number)) {
      const string = match[NUMBER_GROUP3];
      if (string === "\u5E7E") {
        number = 3;
      } else if (string === "\u534A") {
        number = 0.5;
      } else {
        return null;
      }
    }
    let duration = {};
    const unit = match[UNIT_GROUP3];
    const unitAbbr = unit[0];
    if (unitAbbr.match(/[日天星禮月年]/)) {
      if (unitAbbr == "\u65E5" || unitAbbr == "\u5929") {
        duration.day = number;
      } else if (unitAbbr == "\u661F" || unitAbbr == "\u79AE") {
        duration.week = number;
      } else if (unitAbbr == "\u6708") {
        duration.month = number;
      } else if (unitAbbr == "\u5E74") {
        duration.year = number;
      }
      duration = reverseDuration(duration);
      const date2 = addDuration(context.refDate, duration);
      result.start.assign("year", date2.getFullYear());
      result.start.assign("month", date2.getMonth() + 1);
      result.start.assign("day", date2.getDate());
      return result;
    }
    if (unitAbbr == "\u79D2") {
      duration.second = number;
    } else if (unitAbbr == "\u5206") {
      duration.minute = number;
    } else if (unitAbbr == "\u5C0F" || unitAbbr == "\u9418") {
      duration.hour = number;
    }
    duration = reverseDuration(duration);
    const date = addDuration(context.refDate, duration);
    result.start.imply("year", date.getFullYear());
    result.start.imply("month", date.getMonth() + 1);
    result.start.imply("day", date.getDate());
    result.start.assign("hour", date.getHours());
    result.start.assign("minute", date.getMinutes());
    result.start.assign("second", date.getSeconds());
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hant/index.js
var hant = new Chrono(createCasualConfiguration());
var casual = new Chrono(createCasualConfiguration());
var strict = new Chrono(createConfiguration());
function parse(text2, ref, option) {
  return casual.parse(text2, ref, option);
}
__name(parse, "parse");
function parseDate(text2, ref, option) {
  return casual.parseDate(text2, ref, option);
}
__name(parseDate, "parseDate");
function createCasualConfiguration() {
  const option = createConfiguration();
  option.parsers.unshift(new ZHHantCasualDateParser());
  return option;
}
__name(createCasualConfiguration, "createCasualConfiguration");
function createConfiguration() {
  const configuration = includeCommonConfiguration({
    parsers: [
      new ZHHantDateParser(),
      new ZHHantRelationWeekdayParser(),
      new ZHHantWeekdayParser(),
      new ZHHantTimeExpressionParser(),
      new ZHHantDeadlineFormatParser(),
      new ZHHantAgoFormatParser()
    ],
    refiners: [new ZHHantMergeDateRangeRefiner(), new ZHHantMergeDateTimeRefiner()]
  });
  configuration.refiners = configuration.refiners.filter((refiner) => !(refiner instanceof ExtractTimezoneOffsetRefiner));
  return configuration;
}
__name(createConfiguration, "createConfiguration");

// node_modules/chrono-node/dist/esm/locales/zh/hans/index.js
var hans_exports = {};
__export(hans_exports, {
  Chrono: () => Chrono,
  Meridiem: () => Meridiem,
  ParsingComponents: () => ParsingComponents,
  ParsingResult: () => ParsingResult,
  ReferenceWithTimezone: () => ReferenceWithTimezone,
  Weekday: () => Weekday,
  casual: () => casual2,
  createCasualConfiguration: () => createCasualConfiguration2,
  createConfiguration: () => createConfiguration2,
  hans: () => hans,
  parse: () => parse2,
  parseDate: () => parseDate2,
  strict: () => strict2
});

// node_modules/chrono-node/dist/esm/locales/zh/hans/parsers/ZHHansCasualDateParser.js
var NOW_GROUP2 = 1;
var DAY_GROUP_14 = 2;
var TIME_GROUP_12 = 3;
var TIME_GROUP_22 = 4;
var DAY_GROUP_34 = 5;
var TIME_GROUP_32 = 6;
var ZHHansCasualDateParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHansCasualDateParser");
  }
  innerPattern(context) {
    return new RegExp("(\u73B0\u5728|\u7ACB(?:\u523B|\u5373)|\u5373\u523B)|(\u4ECA|\u660E|\u524D|\u5927\u524D|\u540E|\u5927\u540E|\u6628)(\u65E9|\u665A)|(\u4E0A(?:\u5348)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668))|(\u4ECA|\u660E|\u524D|\u5927\u524D|\u540E|\u5927\u540E|\u6628)(?:\u65E5|\u5929)(?:[\\s|,|\uFF0C]*)(?:(\u4E0A(?:\u5348)|\u65E9(?:\u4E0A)|\u4E0B(?:\u5348)|\u665A(?:\u4E0A)|\u591C(?:\u665A)?|\u4E2D(?:\u5348)|\u51CC(?:\u6668)))?", "i");
  }
  innerExtract(context, match) {
    const index = match.index;
    const result = context.createParsingResult(index, match[0]);
    const refDate = context.refDate;
    let date = new Date(refDate.getTime());
    if (match[NOW_GROUP2]) {
      result.start.imply("hour", refDate.getHours());
      result.start.imply("minute", refDate.getMinutes());
      result.start.imply("second", refDate.getSeconds());
      result.start.imply("millisecond", refDate.getMilliseconds());
    } else if (match[DAY_GROUP_14]) {
      const day1 = match[DAY_GROUP_14];
      const time1 = match[TIME_GROUP_12];
      if (day1 == "\u660E") {
        if (refDate.getHours() > 1) {
          date.setDate(date.getDate() + 1);
        }
      } else if (day1 == "\u6628") {
        date.setDate(date.getDate() - 1);
      } else if (day1 == "\u524D") {
        date.setDate(date.getDate() - 2);
      } else if (day1 == "\u5927\u524D") {
        date.setDate(date.getDate() - 3);
      } else if (day1 == "\u540E") {
        date.setDate(date.getDate() + 2);
      } else if (day1 == "\u5927\u540E") {
        date.setDate(date.getDate() + 3);
      }
      if (time1 == "\u65E9") {
        result.start.imply("hour", 6);
      } else if (time1 == "\u665A") {
        result.start.imply("hour", 22);
        result.start.imply("meridiem", 1);
      }
    } else if (match[TIME_GROUP_22]) {
      const timeString2 = match[TIME_GROUP_22];
      const time2 = timeString2[0];
      if (time2 == "\u65E9" || time2 == "\u4E0A") {
        result.start.imply("hour", 6);
      } else if (time2 == "\u4E0B") {
        result.start.imply("hour", 15);
        result.start.imply("meridiem", 1);
      } else if (time2 == "\u4E2D") {
        result.start.imply("hour", 12);
        result.start.imply("meridiem", 1);
      } else if (time2 == "\u591C" || time2 == "\u665A") {
        result.start.imply("hour", 22);
        result.start.imply("meridiem", 1);
      } else if (time2 == "\u51CC") {
        result.start.imply("hour", 0);
      }
    } else if (match[DAY_GROUP_34]) {
      const day3 = match[DAY_GROUP_34];
      if (day3 == "\u660E") {
        if (refDate.getHours() > 1) {
          date.setDate(date.getDate() + 1);
        }
      } else if (day3 == "\u6628") {
        date.setDate(date.getDate() - 1);
      } else if (day3 == "\u524D") {
        date.setDate(date.getDate() - 2);
      } else if (day3 == "\u5927\u524D") {
        date.setDate(date.getDate() - 3);
      } else if (day3 == "\u540E") {
        date.setDate(date.getDate() + 2);
      } else if (day3 == "\u5927\u540E") {
        date.setDate(date.getDate() + 3);
      }
      const timeString3 = match[TIME_GROUP_32];
      if (timeString3) {
        const time3 = timeString3[0];
        if (time3 == "\u65E9" || time3 == "\u4E0A") {
          result.start.imply("hour", 6);
        } else if (time3 == "\u4E0B") {
          result.start.imply("hour", 15);
          result.start.imply("meridiem", 1);
        } else if (time3 == "\u4E2D") {
          result.start.imply("hour", 12);
          result.start.imply("meridiem", 1);
        } else if (time3 == "\u591C" || time3 == "\u665A") {
          result.start.imply("hour", 22);
          result.start.imply("meridiem", 1);
        } else if (time3 == "\u51CC") {
          result.start.imply("hour", 0);
        }
      }
    }
    result.start.assign("day", date.getDate());
    result.start.assign("month", date.getMonth() + 1);
    result.start.assign("year", date.getFullYear());
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hans/parsers/ZHHansAgoFormatParser.js
var PATTERN23 = new RegExp("(\\d+|[" + Object.keys(NUMBER).join("") + "]+|\u534A|\u51E0)(?:\\s*)(?:\u4E2A)?(\u79D2(?:\u949F)?|\u5206\u949F|\u5C0F\u65F6|\u949F|\u65E5|\u5929|\u661F\u671F|\u793C\u62DC|\u6708|\u5E74)(?:\u4E4B)?\u524D", "i");
var NUMBER_GROUP4 = 1;
var UNIT_GROUP4 = 2;
var ZHHansAgoFormatParser = class extends AbstractParserWithWordBoundaryChecking {
  static {
    __name(this, "ZHHansAgoFormatParser");
  }
  innerPattern() {
    return PATTERN23;
  }
  innerExtract(context, match) {
    const result = context.createParsingResult(match.index, match[0]);
    let number = parseInt(match[NUMBER_GROUP4]);
    if (isNaN(number)) {
      number = zhStringToNumber(match[NUMBER_GROUP4]);
    }
    if (isNaN(number)) {
      const string = match[NUMBER_GROUP4];
      if (string === "\u51E0") {
        number = 3;
      } else if (string === "\u534A") {
        number = 0.5;
      } else {
        return null;
      }
    }
    let duration = {};
    const unit = match[UNIT_GROUP4];
    const unitAbbr = unit[0];
    if (unitAbbr.match(/[日天星礼月年]/)) {
      if (unitAbbr == "\u65E5" || unitAbbr == "\u5929") {
        duration.day = number;
      } else if (unitAbbr == "\u661F" || unitAbbr == "\u793C") {
        duration.week = number;
      } else if (unitAbbr == "\u6708") {
        duration.month = number;
      } else if (unitAbbr == "\u5E74") {
        duration.year = number;
      }
      duration = reverseDuration(duration);
      const date2 = addDuration(context.refDate, duration);
      result.start.assign("year", date2.getFullYear());
      result.start.assign("month", date2.getMonth() + 1);
      result.start.assign("day", date2.getDate());
      return result;
    }
    if (unitAbbr == "\u79D2") {
      duration.second = number;
    } else if (unitAbbr == "\u5206") {
      duration.minute = number;
    } else if (unitAbbr == "\u5C0F" || unitAbbr == "\u949F") {
      duration.hour = number;
    }
    duration = reverseDuration(duration);
    const date = addDuration(context.refDate, duration);
    result.start.imply("year", date.getFullYear());
    result.start.imply("month", date.getMonth() + 1);
    result.start.imply("day", date.getDate());
    result.start.assign("hour", date.getHours());
    result.start.assign("minute", date.getMinutes());
    result.start.assign("second", date.getSeconds());
    return result;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hans/refiners/ZHHansMergeDateRangeRefiner.js
var ZHHansMergeDateRangeRefiner = class extends AbstractMergeDateRangeRefiner {
  static {
    __name(this, "ZHHansMergeDateRangeRefiner");
  }
  patternBetween() {
    return /^\s*(至|到|-|~|～|－|ー)\s*$/i;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hans/refiners/ZHHansMergeDateTimeRefiner.js
var ZHHansMergeDateTimeRefiner = class extends AbstractMergeDateTimeRefiner {
  static {
    __name(this, "ZHHansMergeDateTimeRefiner");
  }
  patternBetween() {
    return /^\s*$/i;
  }
};

// node_modules/chrono-node/dist/esm/locales/zh/hans/index.js
var hans = new Chrono(createCasualConfiguration2());
var casual2 = new Chrono(createCasualConfiguration2());
var strict2 = new Chrono(createConfiguration2());
function parse2(text2, ref, option) {
  return casual2.parse(text2, ref, option);
}
__name(parse2, "parse");
function parseDate2(text2, ref, option) {
  return casual2.parseDate(text2, ref, option);
}
__name(parseDate2, "parseDate");
function createCasualConfiguration2() {
  const option = createConfiguration2();
  option.parsers.unshift(new ZHHansCasualDateParser());
  return option;
}
__name(createCasualConfiguration2, "createCasualConfiguration");
function createConfiguration2() {
  const configuration = includeCommonConfiguration({
    parsers: [
      new ZHHansDateParser(),
      new ZHHansRelationWeekdayParser(),
      new ZHHansWeekdayParser(),
      new ZHHansTimeExpressionParser(),
      new ZHHansDeadlineFormatParser(),
      new ZHHansAgoFormatParser()
    ],
    refiners: [new ZHHansMergeDateRangeRefiner(), new ZHHansMergeDateTimeRefiner()]
  });
  configuration.refiners = configuration.refiners.filter((refiner) => !(refiner instanceof ExtractTimezoneOffsetRefiner));
  return configuration;
}
__name(createConfiguration2, "createConfiguration");

// node_modules/chrono-node/dist/esm/locales/zh/index.js
var casual3 = new Chrono(createCasualConfiguration3());
var strict3 = new Chrono(createConfiguration3());
function parse3(text2, ref, option) {
  return casual3.parse(text2, ref, option);
}
__name(parse3, "parse");
function parseDate3(text2, ref, option) {
  return casual3.parseDate(text2, ref, option);
}
__name(parseDate3, "parseDate");
function createCasualConfiguration3() {
  const option = createConfiguration3();
  option.parsers.unshift(new ZHHantCasualDateParser());
  return option;
}
__name(createCasualConfiguration3, "createCasualConfiguration");
function createConfiguration3() {
  const configuration = includeCommonConfiguration({
    parsers: [
      new ZHHantDateParser(),
      new ZHHansDateParser(),
      new ZHHantRelationWeekdayParser(),
      new ZHHansRelationWeekdayParser(),
      new ZHHantWeekdayParser(),
      new ZHHansWeekdayParser(),
      new ZHHantTimeExpressionParser(),
      new ZHHansTimeExpressionParser(),
      new ZHHantDeadlineFormatParser(),
      new ZHHansDeadlineFormatParser()
    ],
    refiners: [new ZHHantMergeDateRangeRefiner(), new ZHHantMergeDateTimeRefiner()]
  });
  configuration.refiners = configuration.refiners.filter((refiner) => !(refiner instanceof ExtractTimezoneOffsetRefiner));
  return configuration;
}
__name(createConfiguration3, "createConfiguration");

// src/core/time.ts
var pad = /* @__PURE__ */ __name((n, width = 2) => String(Math.abs(n)).padStart(width, "0"), "pad");
function toLocalIso(date) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}
__name(toLocalIso, "toLocalIso");
function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
__name(dayKey, "dayKey");
function dayStart(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return /* @__PURE__ */ new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}
__name(dayStart, "dayStart");
function dayEnd(day) {
  const d = dayStart(day);
  d.setHours(23, 59, 59, 999);
  return d;
}
__name(dayEnd, "dayEnd");
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
__name(startOfDay, "startOfDay");
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
__name(addDays, "addDays");
function daysBetween(a, b) {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.round(ms / 864e5);
}
__name(daysBetween, "daysBetween");
var WEEKDAYS = ["\u5468\u65E5", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D"];
function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
__name(formatTime, "formatTime");
function formatDay(date, now2 = /* @__PURE__ */ new Date()) {
  const stem = `${date.getMonth() + 1}\u6708${date.getDate()}\u65E5`;
  return date.getFullYear() === now2.getFullYear() ? stem : `${date.getFullYear()}\u5E74${stem}`;
}
__name(formatDay, "formatDay");
function weekdayLabel(date) {
  return WEEKDAYS[date.getDay()];
}
__name(weekdayLabel, "weekdayLabel");
function formatWhen(date, now2 = /* @__PURE__ */ new Date(), allDay = false) {
  const delta = daysBetween(now2, date);
  const time = allDay ? "" : ` ${formatTime(date)}`;
  if (delta === 0) return `\u4ECA\u5929${time}`;
  if (delta === 1) return `\u660E\u5929${time}`;
  if (delta === -1) return `\u6628\u5929${time}`;
  if (delta > 1 && delta < 7) return `${weekdayLabel(date)}${time}`;
  return `${formatDay(date, now2)} ${weekdayLabel(date)}${time}`;
}
__name(formatWhen, "formatWhen");
function formatMonth(date) {
  return `${date.getFullYear()}\u5E74${date.getMonth() + 1}\u6708`;
}
__name(formatMonth, "formatMonth");
function workspaceLabel(workspaceId) {
  const trimmed = workspaceId.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}
__name(workspaceLabel, "workspaceLabel");

// src/core/parse-when.ts
function normalizeRelative(input, now2) {
  let text2 = input;
  text2 = text2.replace(/大后天/g, `${dayKey(addDays(now2, 3))} `);
  text2 = text2.replace(/后天/g, `${dayKey(addDays(now2, 2))} `);
  text2 = text2.replace(/下个?月\s*(\d{1,2})\s*[号日]/g, (_m, day) => {
    const d = new Date(now2.getFullYear(), now2.getMonth() + 1, Number(day));
    return `${dayKey(d)} `;
  });
  return text2.trim();
}
__name(normalizeRelative, "normalizeRelative");
function parseExplicit(input) {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(input);
  if (iso) {
    const [, y, mo, d, h, mi, s] = iso;
    const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
    if (!Number.isNaN(at.getTime())) return { at, allDay: false, note: "" };
  }
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    const at = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!Number.isNaN(at.getTime())) return { at, allDay: true, note: "" };
  }
  const slash = /^(\d{4}\/)?(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(input);
  if (slash) {
    const [, yearPart, mo, d, h, mi] = slash;
    const now2 = /* @__PURE__ */ new Date();
    let year = yearPart ? Number(yearPart.slice(0, -1)) : now2.getFullYear();
    const at = h ? new Date(year, Number(mo) - 1, Number(d), Number(h), Number(mi)) : new Date(year, Number(mo) - 1, Number(d));
    if (!yearPart && at.getTime() < now2.getTime() - 864e5) {
      at.setFullYear(year + 1);
    }
    if (!Number.isNaN(at.getTime())) return { at, allDay: !h, note: "" };
  }
  return null;
}
__name(parseExplicit, "parseExplicit");
function describeParsed(value, now2 = /* @__PURE__ */ new Date()) {
  const day = `${formatDay(value.at, now2)} ${weekdayLabel(value.at)}`;
  return value.allDay ? `${day} \u5168\u5929` : `${day} ${formatTime(value.at)}`;
}
__name(describeParsed, "describeParsed");
function parseWhen(input, now2 = /* @__PURE__ */ new Date()) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "\u6CA1\u6709\u7ED9\u65F6\u95F4" };
  const explicit = parseExplicit(raw);
  if (explicit) {
    return { ok: true, value: { ...explicit, note: describeParsed(explicit, now2) } };
  }
  const normalized = normalizeRelative(raw, now2);
  const results = zh_exports.parse(normalized, now2, { forwardDate: true });
  const first = results[0];
  if (!first) {
    return {
      ok: false,
      error: `\u8BFB\u4E0D\u51FA\u300C${raw}\u300D\u662F\u4EC0\u4E48\u65F6\u5019\u3002\u53EF\u4EE5\u7528\u8FD9\u4E9B\u5199\u6CD5\uFF1A2026-09-30 14:00\u30012026-09-30\u3001\u660E\u5929\u4E0B\u53483\u70B9\u3001\u4E0B\u5468\u4E94\u3001\u540E\u5929\u3001\u4E0B\u4E2A\u67081\u53F7\u3002`
    };
  }
  const at = first.start.date();
  const certain = first.start.isCertain("hour");
  const allDay = !certain && at.getHours() === 12 && at.getMinutes() === 0;
  const value = { at, allDay, note: "" };
  value.note = describeParsed(value, now2);
  return { ok: true, value };
}
__name(parseWhen, "parseWhen");
var FREE_TEXT_HINT = "\u8FD9\u662F\u6309\u81EA\u7531\u6587\u672C\u8BFB\u51FA\u6765\u7684\u3002\u5982\u679C\u4E0D\u662F\u4F60\u8981\u7684\u65F6\u95F4\uFF0C\u8BF7\u6539\u7528 2026-09-30 14:00 \u8FD9\u6837\u7684\u5199\u6CD5\u3002";

// src/core/recur.ts
var import_rrule = __toESM(require_rrule(), 1);
var ONCE = "once";
function occurrenceKey(at) {
  return at ? at.toISOString() : ONCE;
}
__name(occurrenceKey, "occurrenceKey");
function buildRule(item) {
  if (!item.start || !item.rrule) return null;
  let parsed;
  try {
    parsed = import_rrule.RRule.parseString(item.rrule);
  } catch {
    return null;
  }
  return new import_rrule.RRule({ ...parsed, dtstart: new Date(item.start) });
}
__name(buildRule, "buildRule");
function expandOccurrences(item, from, to) {
  if (!item.start) return [];
  if (to.getTime() < from.getTime()) return [];
  const rule = buildRule(item);
  const dates = rule ? (
    // Inclusive on both ends, then narrowed by the explicit filter below.
    // Doing it this way keeps the `(from, to]` rule visible at the call site
    // instead of depending on a library flag's default.
    rule.between(from, to, true)
  ) : [new Date(item.start)];
  return dates.filter((d) => d.getTime() > from.getTime() && d.getTime() <= to.getTime()).map((d) => ({ itemId: item.id, key: occurrenceKey(d), at: d }));
}
__name(expandOccurrences, "expandOccurrences");
function alignStartToRule(item) {
  if (!item.start || !item.rrule) return item.start;
  const rule = buildRule(item);
  if (!rule) return item.start;
  const from = new Date(item.start);
  const first = rule.after(new Date(from.getTime() - 1), true);
  if (!first) return item.start;
  return first.getTime() === from.getTime() ? item.start : toLocalIso(first);
}
__name(alignStartToRule, "alignStartToRule");
var BYDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function buildRRule(spec) {
  switch (spec.kind) {
    case "none":
      return void 0;
    case "daily":
      return "FREQ=DAILY";
    case "weekly": {
      const days = (spec.byDay ?? []).slice().sort((a, b) => a - b);
      return days.length ? `FREQ=WEEKLY;BYDAY=${days.map((d) => BYDAY_CODES[d]).join(",")}` : "FREQ=WEEKLY";
    }
    case "monthly":
      return "FREQ=MONTHLY";
    case "yearly":
      return "FREQ=YEARLY";
    case "custom":
      return spec.raw?.trim() || void 0;
    default:
      return void 0;
  }
}
__name(buildRRule, "buildRRule");
function parseRepeat(rrule) {
  if (!rrule || !rrule.trim()) return { kind: "none" };
  const body = rrule.trim();
  const freq = /FREQ=([A-Z]+)/.exec(body)?.[1];
  if (freq === "DAILY" && body === "FREQ=DAILY") return { kind: "daily" };
  if (freq === "MONTHLY" && body === "FREQ=MONTHLY") return { kind: "monthly" };
  if (freq === "YEARLY" && body === "FREQ=YEARLY") return { kind: "yearly" };
  if (freq === "WEEKLY") {
    const byday = /BYDAY=([A-Z,]+)/.exec(body)?.[1];
    if (!byday) return { kind: "weekly", byDay: [] };
    const days = byday.split(",").map((code) => BYDAY_CODES.indexOf(code.trim())).filter((i) => i >= 0);
    return { kind: "weekly", byDay: days };
  }
  return { kind: "custom", raw: body };
}
__name(parseRepeat, "parseRepeat");
function describeRepeat(rrule) {
  const spec = parseRepeat(rrule);
  switch (spec.kind) {
    case "none":
      return "\u4E0D\u91CD\u590D";
    case "daily":
      return "\u6BCF\u5929";
    case "weekly":
      return spec.byDay?.length ? `\u6BCF${spec.byDay.map((d) => ["\u5468\u65E5", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D"][d]).join("\u3001")}` : "\u6BCF\u5468";
    case "monthly":
      return "\u6BCF\u6708";
    case "yearly":
      return "\u6BCF\u5E74";
    default:
      return spec.raw ?? "\u81EA\u5B9A\u4E49";
  }
}
__name(describeRepeat, "describeRepeat");

// src/core/triggers.ts
var GRACE_MS = 2 * 6e4;
var MAX_OCCURRENCES = 2e3;
function runKey(itemId, occKey, triggerId) {
  return `${itemId}|${occKey}|${triggerId}`;
}
__name(runKey, "runKey");
function completionKey(itemId, occKey) {
  return `${itemId}|${occKey}`;
}
__name(completionKey, "completionKey");
function fireAt(occurrence, trigger) {
  if (!occurrence.at) return null;
  return new Date(occurrence.at.getTime() + trigger.offsetMinutes * 6e4);
}
__name(fireAt, "fireAt");
function dueRuns(items, alreadyRun, from, to, now2 = to, graceMs = GRACE_MS) {
  const toFire = [];
  const missed = [];
  const truncated = [];
  for (const item of items) {
    if (!item.start) continue;
    const triggers = item.triggers.filter((t) => t.enabled);
    if (triggers.length === 0) continue;
    const offsets = triggers.map((t) => t.offsetMinutes);
    const maxOffset = Math.max(...offsets);
    const minOffset = Math.min(...offsets);
    const searchFrom = new Date(from.getTime() - maxOffset * 6e4);
    const searchTo = new Date(to.getTime() - minOffset * 6e4);
    const occurrences = expandOccurrences(item, searchFrom, searchTo);
    if (occurrences.length >= MAX_OCCURRENCES) truncated.push(item.id);
    for (const occurrence of occurrences) {
      if (occurrence.key !== void 0 && item.completions.includes(occurrence.key)) continue;
      for (const trigger of triggers) {
        const at = fireAt(occurrence, trigger);
        if (!at) continue;
        const t = at.getTime();
        if (t <= from.getTime() || t > to.getTime()) continue;
        const key = runKey(item.id, occurrence.key, trigger.id);
        if (alreadyRun.has(key)) continue;
        const run = { item, occurrence, trigger, fireAt: at, key };
        if (t < now2.getTime() - graceMs) missed.push(run);
        else toFire.push(run);
      }
    }
  }
  const byTime = /* @__PURE__ */ __name((a, b) => a.fireAt.getTime() - b.fireAt.getTime(), "byTime");
  toFire.sort(byTime);
  missed.sort(byTime);
  return { toFire, missed, truncated };
}
__name(dueRuns, "dueRuns");
function nextTriggerAt(item, now2) {
  if (!item.start) return null;
  const triggers = item.triggers.filter((t) => t.enabled);
  if (triggers.length === 0) return null;
  const offsets = triggers.map((t) => t.offsetMinutes);
  const maxOffset = Math.max(...offsets);
  const horizon = new Date(now2.getTime() + 400 * 864e5);
  const occurrences = expandOccurrences(
    item,
    new Date(now2.getTime() - (maxOffset + 1) * 6e4),
    horizon
  );
  let best = null;
  for (const occurrence of occurrences) {
    if (item.completions.includes(occurrence.key)) continue;
    for (const trigger of triggers) {
      const at = fireAt(occurrence, trigger);
      if (!at || at.getTime() <= now2.getTime()) continue;
      if (!best || at.getTime() < best.getTime()) best = at;
    }
  }
  return best;
}
__name(nextTriggerAt, "nextTriggerAt");
function nextFireAcrossItems(items, now2) {
  let best = null;
  for (const item of items) {
    const next = nextTriggerAt(item, now2);
    if (next && (!best || next.getTime() < best.getTime())) best = next;
  }
  return best;
}
__name(nextFireAcrossItems, "nextFireAcrossItems");
function currentOccurrenceKey(item, now2) {
  if (!item.start) return ONCE;
  if (!item.rrule) return occurrenceKey(new Date(item.start));
  const past = expandOccurrences(item, new Date(now2.getTime() - 400 * 864e5), now2);
  if (past.length > 0) return past[past.length - 1].key;
  const upcoming = expandOccurrences(item, now2, new Date(now2.getTime() + 400 * 864e5));
  return upcoming[0]?.key ?? occurrenceKey(new Date(item.start));
}
__name(currentOccurrenceKey, "currentOccurrenceKey");
function describeTrigger(trigger) {
  const when = trigger.offsetMinutes === 0 ? "\u5230\u70B9\u65F6" : trigger.offsetMinutes < 0 ? `\u63D0\u524D ${formatSpan(-trigger.offsetMinutes)}` : `\u4E4B\u540E ${formatSpan(trigger.offsetMinutes)}`;
  const what = trigger.action.kind === "notify" ? "\u7CFB\u7EDF\u901A\u77E5" : "\u8BA9 agent \u5E72\u6D3B";
  return `${when} \xB7 ${what}`;
}
__name(describeTrigger, "describeTrigger");
function formatSpan(minutes) {
  if (minutes < 60) return `${minutes} \u5206\u949F`;
  if (minutes % 60 === 0) return `${minutes / 60} \u5C0F\u65F6`;
  if (minutes % 1440 === 0) return `${minutes / 1440} \u5929`;
  return `${Math.floor(minutes / 60)} \u5C0F\u65F6 ${minutes % 60} \u5206\u949F`;
}
__name(formatSpan, "formatSpan");

// src/core/migrate.ts
var STATE_VERSION = 2;
function emptyState() {
  return { version: STATE_VERSION, items: [], runs: [], notes: {}, completedAt: {} };
}
__name(emptyState, "emptyState");
function isDayNote(value) {
  return Boolean(value) && typeof value === "object" && typeof value.text === "string";
}
__name(isDayNote, "isDayNote");
function migrateState(saved) {
  const raw = saved && typeof saved === "object" ? saved : {};
  const version = typeof raw.version === "number" ? raw.version : 1;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const runs = Array.isArray(raw.runs) ? raw.runs : [];
  const rawNotes = raw.notes && typeof raw.notes === "object" ? raw.notes : {};
  const notes = {};
  let changed = version !== STATE_VERSION;
  for (const [day, value] of Object.entries(rawNotes)) {
    if (isDayNote(value)) {
      notes[day] = { "": value };
      changed = true;
    } else if (value && typeof value === "object") {
      notes[day] = value;
    }
  }
  const rawCompleted = raw.completedAt && typeof raw.completedAt === "object" ? raw.completedAt : {};
  const completedAt = version < STATE_VERSION ? migrateCompletions(items, rawCompleted) : rawCompleted;
  const state2 = {
    version: STATE_VERSION,
    items,
    runs,
    notes,
    completedAt,
    lastTickAt: typeof raw.lastTickAt === "string" ? raw.lastTickAt : void 0
  };
  return { state: state2, changed };
}
__name(migrateState, "migrateState");
function migrateCompletions(items, old) {
  const claimants = /* @__PURE__ */ new Map();
  for (const item of items) {
    for (const key of item.completions ?? []) {
      const list = claimants.get(key);
      if (list) list.push(item.id);
      else claimants.set(key, [item.id]);
    }
  }
  const next = {};
  for (const [key, at] of Object.entries(old)) {
    const owners = claimants.get(key);
    if (owners?.length === 1) next[completionKey(owners[0], key)] = at;
  }
  return next;
}
__name(migrateCompletions, "migrateCompletions");

// src/core/day.ts
var MISSED_STATUSES = /* @__PURE__ */ new Set(["missed", "undelivered"]);
function buildDayPage(items, runs, notes, completedAt, day) {
  const start = dayStart(day);
  const end = dayEnd(day);
  const planned = [];
  const done = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of items) {
    const repeats = Boolean(item.rrule);
    const occurrences = expandOccurrences(item, new Date(start.getTime() - 1), end);
    for (const occ of occurrences) {
      const entry = {
        itemId: item.id,
        title: item.title,
        key: occ.key,
        at: occ.at ? toLocalIso(occ.at) : void 0,
        repeat: repeats,
        workspaceId: item.workspaceId
      };
      seen.add(`${item.id}|${occ.key}`);
      if (item.completions.includes(occ.key)) done.push(entry);
      else planned.push(entry);
    }
    if (!item.start) {
      for (const key of item.completions) {
        const at = completedAt[completionKey(item.id, key)];
        if (!at || dayKey(new Date(at)) !== day) continue;
        if (seen.has(`${item.id}|${key}`)) continue;
        done.push({
          itemId: item.id,
          title: item.title,
          key,
          repeat: false,
          workspaceId: item.workspaceId
        });
      }
    }
  }
  const missed = runs.filter(
    (r) => MISSED_STATUSES.has(r.status) && dayKey(new Date(r.dueAt)) === day
  );
  const byTime = /* @__PURE__ */ __name((a, b) => (a.at ?? "") < (b.at ?? "") ? -1 : (a.at ?? "") > (b.at ?? "") ? 1 : 0, "byTime");
  planned.sort(byTime);
  done.sort(byTime);
  return { day, planned, done, missed, notes: notes[day] ?? {} };
}
__name(buildDayPage, "buildDayPage");

// src/backend/index.ts
var ctx;
var STORAGE_KEY = "tasks";
var MAX_RUNS = 500;
var MAX_TICK_MS = 3e4;
var MIN_TICK_MS = 250;
var state = emptyState();
var PANEL = "items";
async function load() {
  const saved = await ctx.call("storage.get", { key: STORAGE_KEY }).catch(() => void 0);
  const { state: next, changed } = migrateState(saved);
  state = next;
  if (changed) await save();
}
__name(load, "load");
async function save() {
  if (state.runs.length > MAX_RUNS) {
    state.runs = state.runs.slice(-MAX_RUNS);
  }
  await ctx.call("storage.set", { key: STORAGE_KEY, value: state }).catch((err) => {
    ctx.log.error(`storage.set failed: ${err.message}`);
  });
}
__name(save, "save");
function groupOf(start, now2) {
  if (!start) return "undated";
  const days = Math.floor(
    (new Date(start).setHours(0, 0, 0, 0) - new Date(now2).setHours(0, 0, 0, 0)) / 864e5
  );
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return "week";
  return "later";
}
__name(groupOf, "groupOf");
function toViewItem(item, now2) {
  const occKey = currentOccurrenceKey(item, now2);
  const start = item.start ? new Date(item.start) : void 0;
  const next = nextTriggerAt(item, now2);
  const done = item.completions.includes(occKey);
  return {
    id: item.id,
    title: item.title,
    note: item.note,
    start: item.start,
    end: item.end,
    allDay: Boolean(item.allDay),
    rrule: item.rrule,
    repeatLabel: describeRepeat(item.rrule),
    triggers: item.triggers,
    triggerLabels: item.triggers.map(describeTrigger),
    done,
    occurrenceKey: occKey,
    nextFireAt: next ? next.toISOString() : void 0,
    whenLabel: item.start ? item.allDay ? `${formatWhen(start, now2, true)} \u5168\u5929` : formatWhen(start, now2) : "\u65E0\u65E5\u671F",
    group: groupOf(start, now2),
    workspaceId: item.workspaceId
  };
}
__name(toViewItem, "toViewItem");
function knownWorkspaces() {
  const ids = /* @__PURE__ */ new Set();
  for (const item of state.items) if (item.workspaceId) ids.add(item.workspaceId);
  for (const scopes of Object.values(state.notes)) {
    for (const key of Object.keys(scopes)) if (key) ids.add(key);
  }
  return [...ids].sort();
}
__name(knownWorkspaces, "knownWorkspaces");
function buildView(now2, truncated = []) {
  const runs = [...state.runs].reverse();
  return {
    // Deliberately unfiltered: the panel is the only place that knows which
    // workspace IT is showing, and `ui.render` goes to every window's view of
    // this panel. Filtering here would mean the last window to mount decides
    // what all of them see.
    items: state.items.map((i) => toViewItem(i, now2)),
    workspaces: knownWorkspaces(),
    runs,
    missed: runs.filter((r) => r.status === "missed" || r.status === "undelivered"),
    notes: state.notes,
    now: now2.toISOString(),
    truncated
  };
}
__name(buildView, "buildView");
function dayPage(day) {
  return buildDayPage(state.items, state.runs, state.notes, state.completedAt, day);
}
__name(dayPage, "dayPage");
function scopedDayPage(day, workspaceId, all) {
  const page = dayPage(day);
  if (all) return page;
  const keep = /* @__PURE__ */ __name((e) => !e.workspaceId || e.workspaceId === workspaceId, "keep");
  const notes = {};
  for (const [scope, note] of Object.entries(page.notes)) {
    if (!scope || scope === workspaceId) notes[scope] = note;
  }
  return { ...page, planned: page.planned.filter(keep), done: page.done.filter(keep), notes };
}
__name(scopedDayPage, "scopedDayPage");
function occurrencesBetween(from, to) {
  const byDay = {};
  const start = new Date(from.getTime() - 1);
  for (const item of state.items) {
    for (const occ of expandOccurrences(item, start, to)) {
      const key = dayKey(occ.at);
      (byDay[key] ??= []).push({
        itemId: item.id,
        title: item.title,
        key: occ.key,
        at: toLocalIso(occ.at),
        allDay: Boolean(item.allDay),
        done: item.completions.includes(occ.key),
        workspaceId: item.workspaceId
      });
    }
  }
  for (const list of Object.values(byDay)) {
    list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }
  return byDay;
}
__name(occurrencesBetween, "occurrencesBetween");
function noteLines(page) {
  return Object.entries(page.notes).filter(([, n]) => Boolean(n.text?.trim())).sort(([a], [b]) => a < b ? -1 : 1).map(([scope, n]) => `${scope ? `[${workspaceLabel(scope)}] ` : ""}${n.text.trim()}`);
}
__name(noteLines, "noteLines");
function render(truncated = []) {
  ctx.send(PANEL, "ui.render", buildView(/* @__PURE__ */ new Date(), truncated));
  scheduleNextTick();
}
__name(render, "render");
var ticking = false;
var tickTimer = null;
function scheduleNextTick() {
  if (tickTimer) clearTimeout(tickTimer);
  const now2 = /* @__PURE__ */ new Date();
  const next = nextFireAcrossItems(state.items, now2);
  const delay = next === null ? MAX_TICK_MS : Math.min(Math.max(next.getTime() - now2.getTime(), MIN_TICK_MS), MAX_TICK_MS);
  tickTimer = setTimeout(() => void tick(), delay);
}
__name(scheduleNextTick, "scheduleNextTick");
async function tick() {
  if (ticking) return;
  ticking = true;
  const now2 = /* @__PURE__ */ new Date();
  try {
    const from = state.lastTickAt ? new Date(state.lastTickAt) : now2;
    const alreadyRun = new Set(state.runs.map((r) => r.key));
    const { toFire, missed, truncated } = dueRuns(state.items, alreadyRun, from, now2, now2);
    for (const run of missed) {
      state.runs.push(record(run, "missed", void 0, "\u5F53\u65F6\u5E94\u7528\u6CA1\u6709\u5728\u8FD0\u884C"));
    }
    for (const run of toFire) {
      await perform(run);
    }
    state.lastTickAt = now2.toISOString();
    await save();
    render(truncated);
  } catch (err) {
    ctx.log.error(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    scheduleNextTick();
  } finally {
    ticking = false;
  }
}
__name(tick, "tick");
function record(run, status, firedAt, detail) {
  return {
    key: run.key,
    itemId: run.item.id,
    itemTitle: run.item.title,
    occurrenceKey: run.occurrence.key,
    triggerId: run.trigger.id,
    dueAt: toLocalIso(run.fireAt),
    firedAt: firedAt ? toLocalIso(firedAt) : void 0,
    action: run.trigger.action.kind,
    status,
    detail
  };
}
__name(record, "record");
async function perform(run) {
  const { trigger, item, fireAt: fireAt2 } = run;
  const now2 = /* @__PURE__ */ new Date();
  void ctx.call("panel.open", { panelId: "items", focus: false }).catch(() => void 0);
  if (trigger.action.kind === "notify") {
    const title = trigger.action.title || item.title;
    const body = [formatWhen(fireAt2, now2, Boolean(item.allDay)), item.workspaceId ? workspaceLabel(item.workspaceId) : "", item.note].filter(Boolean).join(" \xB7 ");
    try {
      await ctx.call("notify.show", { title, body });
      state.runs.push(record(run, "ok", now2, "\u5DF2\u53D1\u9001\u7CFB\u7EDF\u901A\u77E5"));
    } catch (err) {
      state.runs.push(record(run, "failed", now2, err instanceof Error ? err.message : String(err)));
    }
    return;
  }
  if (!await ctx.panelAlive(PANEL)) {
    state.runs.push(record(run, "undelivered", void 0, "\u5F53\u65F6\u6CA1\u6709\u6253\u5F00\u4EFB\u4F55\u7A97\u53E3"));
    return;
  }
  try {
    await ctx.call("chat.send", {
      text: trigger.action.prompt,
      ...item.workspaceId ? { workspaceId: item.workspaceId } : {}
    });
    state.runs.push(record(run, "ok", now2, "\u5DF2\u9001\u8FDB\u5BF9\u8BDD"));
  } catch (err) {
    state.runs.push(
      record(run, "undelivered", void 0, `\u6CA1\u80FD\u9001\u8FDB\u5BF9\u8BDD\uFF08${errMessage(err)}\uFF09\u2014\u2014 \u901A\u5E38\u662F\u5E94\u7528\u7A97\u53E3\u5DF2\u7ECF\u5173\u95ED`)
    );
  }
}
__name(perform, "perform");
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
__name(errMessage, "errMessage");
async function rerun(key) {
  const existing = state.runs.find((r) => r.key === key);
  if (!existing) return;
  state.runs = state.runs.filter((r) => r.key !== key);
  const item = state.items.find((i) => i.id === existing.itemId);
  const trigger = item?.triggers.find((t) => t.id === existing.triggerId);
  if (!item || !trigger || !item.start) {
    await save();
    render();
    return;
  }
  await perform({
    item,
    occurrence: { itemId: item.id, key: existing.occurrenceKey, at: new Date(existing.occurrenceKey) },
    trigger,
    fireAt: new Date(existing.dueAt),
    key: existing.key
  });
  await save();
  render();
}
__name(rerun, "rerun");
function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
__name(newId, "newId");
function newTrigger(action, offsetMinutes) {
  return { id: newId("g"), offsetMinutes, action, enabled: true };
}
__name(newTrigger, "newTrigger");
function saveItem(input) {
  const existing = input.id ? state.items.find((i) => i.id === input.id) : void 0;
  const item = existing ?? {
    id: newId("i"),
    title: "",
    createdAt: toLocalIso(/* @__PURE__ */ new Date()),
    completions: [],
    triggers: []
  };
  if (input.title !== void 0) item.title = String(input.title).slice(0, 200);
  if (input.note !== void 0) item.note = String(input.note).slice(0, 2e3) || void 0;
  if (input.start !== void 0) item.start = input.start || void 0;
  if (input.end !== void 0) item.end = input.end || void 0;
  if (input.allDay !== void 0) item.allDay = input.allDay;
  if (input.rrule !== void 0) item.rrule = input.rrule || void 0;
  if (input.triggers !== void 0) item.triggers = input.triggers;
  if (input.workspaceId !== void 0) item.workspaceId = input.workspaceId || void 0;
  if (!item.start) {
    item.triggers = [];
    item.rrule = void 0;
  }
  if (existing) {
    state.items = state.items.map((i) => i.id === item.id ? item : i);
  } else {
    state.items = [...state.items, item];
  }
  if (item.rrule && item.start) {
    const aligned = alignStartToRule(item);
    if (aligned && aligned !== item.start) item.start = aligned;
  }
  return item;
}
__name(saveItem, "saveItem");
function setCompletion(item, key, done, now2 = /* @__PURE__ */ new Date()) {
  const stamp = completionKey(item.id, key);
  if (done) {
    item.completions = Array.from(/* @__PURE__ */ new Set([...item.completions, key]));
    state.completedAt[stamp] = toLocalIso(now2);
  } else {
    item.completions = item.completions.filter((k) => k !== key);
    delete state.completedAt[stamp];
  }
}
__name(setCompletion, "setCompletion");
function itemsInScope(workspaceId, all) {
  if (all) return state.items;
  return state.items.filter((i) => !i.workspaceId || i.workspaceId === workspaceId);
}
__name(itemsInScope, "itemsInScope");
function wantsAll(scope) {
  return String(scope ?? "").trim().toLowerCase() === "all";
}
__name(wantsAll, "wantsAll");
function wantsGlobal(scope) {
  return String(scope ?? "").trim().toLowerCase() === "global";
}
__name(wantsGlobal, "wantsGlobal");
function findByTitle(title, pool, preferOpen = true) {
  const needle = String(title ?? "").trim();
  if (!needle) return void 0;
  const matches = pool.filter((i) => i.title.includes(needle)).sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  return preferOpen && matches.find((i) => i.completions.length === 0) || matches[0];
}
__name(findByTitle, "findByTitle");
var text = /* @__PURE__ */ __name((t) => ({ content: [{ type: "text", text: t }] }), "text");
var STATUS_CN = {
  ok: "\u5DF2\u5B8C\u6210",
  missed: "\u9519\u8FC7",
  undelivered: "\u6CA1\u9001\u5230",
  failed: "\u51FA\u9519"
};
function repeatSpec(value) {
  const spec = String(value ?? "").trim();
  if (!spec) return void 0;
  if (spec.toUpperCase().includes("FREQ=")) return spec;
  const kind = spec.toLowerCase();
  if (kind === "daily" || kind === "weekly" || kind === "monthly" || kind === "yearly") {
    return buildRRule({ kind });
  }
  throw new Error(
    `\u770B\u4E0D\u61C2\u7684\u91CD\u590D\u65B9\u5F0F\uFF1A${spec}\u3002\u53EF\u7528 daily / weekly / monthly / yearly\uFF0C\u6216\u76F4\u63A5\u7ED9 RRULE\uFF0C\u4F8B\u5982 FREQ=WEEKLY;BYDAY=MO\u3002`
  );
}
__name(repeatSpec, "repeatSpec");
async function onTool(name, params, _context, call = {}) {
  const p = params ?? {};
  const workspaceId = call.workspaceId;
  switch (name) {
    case "item_add": {
      if (!p.title) throw new Error("missing title");
      let start;
      let allDay = false;
      let echo = "";
      if (p.when) {
        const parsed = parseWhen(String(p.when));
        if (!parsed.ok) throw new Error(parsed.error);
        start = toLocalIso(parsed.value.at);
        allDay = parsed.value.allDay;
        echo = parsed.value.note;
      }
      let rrule;
      if (p.repeat !== void 0 && p.repeat !== null && String(p.repeat).trim() !== "") {
        rrule = repeatSpec(p.repeat);
        if (rrule && !start) throw new Error("\u8981\u91CD\u590D\u5C31\u5F97\u5148\u6709\u65F6\u95F4\u3002\u8BF7\u540C\u65F6\u7ED9 when\u3002");
      }
      const triggers = [];
      if (p.remindBefore !== void 0) {
        const minutes = Number(p.remindBefore);
        if (!Number.isFinite(minutes)) throw new Error("remindBefore \u8981\u662F\u4E00\u4E2A\u5206\u949F\u6570");
        triggers.push(newTrigger({ kind: "notify" }, -Math.abs(minutes)));
      }
      if (p.onDue) {
        triggers.push(newTrigger({ kind: "agent", prompt: String(p.onDue) }, 0));
      }
      if (triggers.length > 0 && !start) {
        throw new Error("\u8981\u8BBE\u63D0\u9192\u5C31\u5F97\u5148\u6709\u65F6\u95F4\u3002\u8BF7\u540C\u65F6\u7ED9 when\u3002");
      }
      const item = saveItem({
        title: String(p.title),
        note: p.note === void 0 ? void 0 : String(p.note),
        start,
        allDay,
        rrule,
        triggers,
        workspaceId: wantsGlobal(p.scope) ? null : workspaceId
      });
      await save();
      render();
      const lines = [`\u5DF2\u8BB0\u4E0B\uFF1A${item.title}`];
      if (echo) lines.push(`\u65F6\u95F4\uFF1A${echo}${p.when && !String(p.when).match(/^\d{4}-/) ? `\uFF08${FREE_TEXT_HINT}\uFF09` : ""}`);
      else lines.push("\u65F6\u95F4\uFF1A\u65E0\uFF08\u7EAF\u5F85\u529E\uFF09");
      if (item.rrule) lines.push(`\u91CD\u590D\uFF1A${describeRepeat(item.rrule)}`);
      lines.push(`\u5F52\u5C5E\uFF1A${item.workspaceId ? workspaceLabel(item.workspaceId) : "\u5168\u5C40"}`);
      for (const t of item.triggers) lines.push(`\u89E6\u53D1\uFF1A${describeTrigger(t)}`);
      return {
        ...text(lines.join("\n")),
        card: {
          component: "Card",
          props: { title: "\u5DF2\u8BB0\u4E0B" },
          children: [
            {
              component: "KeyValue",
              props: {
                items: [
                  ["\u4E8B\u9879", item.title],
                  ...echo ? [["\u65F6\u95F4", echo]] : [],
                  ["\u5F52\u5C5E", item.workspaceId ? workspaceLabel(item.workspaceId) : "\u5168\u5C40"],
                  ...item.rrule ? [["\u91CD\u590D", describeRepeat(item.rrule)]] : [],
                  ...item.triggers.map((t) => ["\u89E6\u53D1", describeTrigger(t)])
                ]
              }
            }
          ]
        }
      };
    }
    case "day_read": {
      const today2 = dayKey(/* @__PURE__ */ new Date());
      const to = String(p.to ?? today2);
      const from = String(p.from ?? (p.day ? p.day : dayKey(addDays(/* @__PURE__ */ new Date(), -6))));
      const fromD = dayStart(from);
      const toD = dayStart(to);
      if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
        throw new Error("\u65E5\u671F\u8981\u5199\u6210 2026-09-30 \u8FD9\u6837");
      }
      const span = Math.round((toD.getTime() - fromD.getTime()) / 864e5);
      if (span < 0) throw new Error("from \u6BD4 to \u8FD8\u665A");
      if (span > 90) throw new Error("\u4E00\u6B21\u6700\u591A\u8BFB 90 \u5929\uFF0C\u8BF7\u7F29\u77ED\u8303\u56F4");
      const all = wantsAll(p.scope);
      const lines = [];
      let wrote = 0;
      for (let i = 0; i <= span; i++) {
        const day = dayKey(addDays(fromD, i));
        const page = scopedDayPage(day, workspaceId, all);
        const notes = noteLines(page);
        const empty = page.planned.length === 0 && page.done.length === 0 && page.missed.length === 0 && notes.length === 0;
        if (empty) continue;
        wrote++;
        lines.push(`\u3010${day} ${weekdayLabel(dayStart(day))}\u3011`);
        if (page.done.length) lines.push(`  \u5B8C\u6210\uFF1A${page.done.map((e) => e.title).join("\u3001")}`);
        if (page.planned.length) lines.push(`  \u6CA1\u5B8C\u6210\uFF1A${page.planned.map((e) => e.title).join("\u3001")}`);
        if (page.missed.length) {
          lines.push(`  \u9519\u8FC7\u7684\u89E6\u53D1\uFF1A${page.missed.map((r) => `${r.itemTitle}\uFF08${STATUS_CN[r.status]}\uFF09`).join("\u3001")}`);
        }
        if (notes.length) lines.push(`  \u7528\u6237\u5199\u7684\uFF1A${notes.join("\n    ")}`);
        lines.push("");
      }
      if (wrote === 0) return text(`${from} \u5230 ${to} \u4E4B\u95F4\u6CA1\u6709\u4EFB\u4F55\u8BB0\u5F55\u3002`);
      return text(`\u4ECE ${from} \u5230 ${to} \u7684\u8BB0\u5F55\uFF1A

${lines.join("\n")}`);
    }
    case "day_write": {
      const day = String(p.day ?? dayKey(/* @__PURE__ */ new Date()));
      if (Number.isNaN(dayStart(day).getTime())) throw new Error("\u65E5\u671F\u8981\u5199\u6210 2026-09-30 \u8FD9\u6837");
      const body = String(p.text ?? "").trim();
      if (!body) throw new Error("\u6CA1\u7ED9\u8981\u5199\u7684\u5185\u5BB9");
      const mode = p.mode === "replace" ? "replace" : "append";
      const scopeKey = wantsGlobal(p.scope) ? "" : workspaceId ?? "";
      const existing = state.notes[day]?.[scopeKey]?.text ?? "";
      const next = mode === "replace" || !existing.trim() ? body : `${existing}

${body}`;
      state.notes[day] = {
        ...state.notes[day] ?? {},
        [scopeKey]: { text: next, updatedAt: toLocalIso(/* @__PURE__ */ new Date()) }
      };
      await save();
      render();
      return text(
        `\u5DF2\u5199\u5165 ${day} \u7684\u8BB0\u5F55${scopeKey ? `\uFF08${workspaceLabel(scopeKey)}\uFF09` : "\uFF08\u5168\u5C40\uFF09"}${mode === "replace" && existing.trim() ? "\uFF0C\u8986\u76D6\u4E86\u539F\u6765\u7684\u5185\u5BB9" : ""}\u3002
\u73B0\u5728\u8FD9\u4E00\u5929\u662F\uFF1A
${next}`
      );
    }
    case "item_list": {
      const now2 = /* @__PURE__ */ new Date();
      const range = String(p.range ?? "week");
      const all = wantsAll(p.scope);
      let items = itemsInScope(workspaceId, all);
      if (range === "today") {
        const today2 = dayKey(now2);
        items = items.filter((i) => i.start && dayKey(new Date(i.start)) === today2);
      } else if (range === "week") {
        const end = new Date(now2.getTime() + 7 * 864e5);
        items = items.filter((i) => i.start && new Date(i.start) <= end);
      }
      if (items.length === 0) return text("\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u4E8B\u9879\u3002");
      const lines = items.sort((a, b) => (a.start ?? "9999") < (b.start ?? "9999") ? -1 : 1).map((i) => {
        const v = toViewItem(i, now2);
        const mark = v.done ? "\u2713" : "\u25CB";
        const rep = i.rrule ? ` \u21BB${describeRepeat(i.rrule)}` : "";
        const fire = v.nextFireAt ? ` \xB7 \u4E0B\u6B21\u89E6\u53D1 ${formatWhen(new Date(v.nextFireAt), now2)}` : "";
        const owner = i.workspaceId ? ` \xB7[${workspaceLabel(i.workspaceId)}]` : " \xB7[\u5168\u5C40]";
        return `${mark} ${v.whenLabel} \u2014 ${i.title}${owner}${rep}${fire}${i.note ? `\uFF08${i.note}\uFF09` : ""}`;
      });
      const open = items.filter((i) => !toViewItem(i, now2).done).length;
      const where = all ? "\u5168\u90E8\u5DE5\u4F5C\u533A" : `${workspaceId ? workspaceLabel(workspaceId) : "\u5168\u5C40"} \u53CA\u5168\u5C40`;
      return text(`\u4E8B\u9879\uFF08\u8303\u56F4\uFF1A${range}\uFF0C${where}\uFF0C${open} \u9879\u672A\u5B8C\u6210\uFF09\uFF1A
${lines.join("\n")}`);
    }
    case "item_update": {
      const item = findByTitle(String(p.title ?? ""), itemsInScope(workspaceId, wantsAll(p.scope)), true);
      if (!item) throw new Error(`\u6CA1\u627E\u5230\u4E8B\u9879\uFF1A${p.title}${wantsAll(p.scope) ? "" : '\uFF08\u53EA\u5728\u5F53\u524D\u5DE5\u4F5C\u533A\u548C\u5168\u5C40\u91CC\u627E\uFF1B\u8981\u8DE8\u5DE5\u4F5C\u533A\u8BF7\u7528 scope: "all"\uFF09'}`);
      const input = { id: item.id };
      if (p.when !== void 0) {
        if (p.when === null || p.when === "") {
          input.start = null;
        } else {
          const parsed = parseWhen(String(p.when));
          if (!parsed.ok) throw new Error(parsed.error);
          input.start = toLocalIso(parsed.value.at);
          input.allDay = parsed.value.allDay;
        }
      }
      if (p.note !== void 0) input.note = String(p.note);
      if (p.repeat !== void 0) {
        const next = repeatSpec(p.repeat);
        if (next && !(input.start !== void 0 ? input.start : item.start)) {
          throw new Error("\u8981\u91CD\u590D\u5C31\u5F97\u5148\u6709\u65F6\u95F4\u3002\u8BF7\u540C\u65F6\u7ED9 when\u3002");
        }
        input.rrule = next ?? null;
      }
      const updated = saveItem(input);
      if (p.done !== void 0) {
        setCompletion(updated, currentOccurrenceKey(updated, /* @__PURE__ */ new Date()), Boolean(p.done));
      }
      await save();
      render();
      const v = toViewItem(updated, /* @__PURE__ */ new Date());
      return text(`\u5DF2\u66F4\u65B0\uFF1A${updated.title}
\u65F6\u95F4\uFF1A${v.whenLabel}
\u72B6\u6001\uFF1A${v.done ? "\u5DF2\u5B8C\u6210" : "\u672A\u5B8C\u6210"}`);
    }
    case "item_remove": {
      const item = findByTitle(String(p.title ?? ""), itemsInScope(workspaceId, wantsAll(p.scope)), false);
      if (!item) throw new Error(`\u6CA1\u627E\u5230\u4E8B\u9879\uFF1A${p.title}${wantsAll(p.scope) ? "" : '\uFF08\u53EA\u5728\u5F53\u524D\u5DE5\u4F5C\u533A\u548C\u5168\u5C40\u91CC\u627E\uFF1B\u8981\u8DE8\u5DE5\u4F5C\u533A\u8BF7\u7528 scope: "all"\uFF09'}`);
      state.items = state.items.filter((i) => i.id !== item.id);
      await save();
      render();
      return text(`\u5DF2\u5220\u9664\uFF1A${item.title}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
__name(onTool, "onTool");
async function onUiRequest(method, params) {
  switch (method) {
    case "state.get":
      return buildView(/* @__PURE__ */ new Date());
    /**
     * One day's page.
     *
     * `workspaceId` narrows it to that project plus global; `scope: 'all'`
     * keeps every project. The panel sends whichever its filter is showing —
     * the backend does not guess, because it cannot know which window asked.
     */
    case "day.get": {
      const day = String(params?.day ?? dayKey(/* @__PURE__ */ new Date()));
      const workspaceId = typeof params?.workspaceId === "string" && params.workspaceId ? params.workspaceId : void 0;
      return scopedDayPage(day, workspaceId, wantsAll(params?.scope));
    }
    /**
     * Write the day's free text.
     *
     * The note is the user's own words, so the destructive shape is opt-in:
     * callers pass `mode: 'replace'` explicitly, and anything else appends.
     * Reaching for a text field and wiping what someone wrote about their day
     * is not a failure mode worth leaving to a default.
     */
    case "day.note.set": {
      const day = String(params?.day ?? dayKey(/* @__PURE__ */ new Date()));
      const text2 = String(params?.text ?? "");
      const mode = params?.mode === "replace" ? "replace" : "append";
      const scopeKey = typeof params?.workspaceId === "string" && params.workspaceId ? params.workspaceId : "";
      const dayNotes = state.notes[day] ?? {};
      const existing = dayNotes[scopeKey]?.text ?? "";
      const next = mode === "replace" || !existing.trim() ? text2 : `${existing}

${text2}`;
      if (next.trim()) {
        state.notes[day] = { ...dayNotes, [scopeKey]: { text: next, updatedAt: toLocalIso(/* @__PURE__ */ new Date()) } };
      } else {
        delete dayNotes[scopeKey];
        if (Object.keys(dayNotes).length > 0) state.notes[day] = dayNotes;
        else delete state.notes[day];
      }
      await save();
      render();
      return { ok: true, day, workspaceId: scopeKey, text: next };
    }
    /** Occurrences for the month grid. The panel cannot expand RRULEs itself. */
    case "month.get": {
      const year = Number(params?.year ?? (/* @__PURE__ */ new Date()).getFullYear());
      const month = Number(params?.month ?? (/* @__PURE__ */ new Date()).getMonth());
      const from = new Date(year, month, 1, 0, 0, 0, 0);
      const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
      return { year, month, label: formatMonth(from), byDay: occurrencesBetween(from, to) };
    }
    /**
     * Occurrences for an arbitrary span of whole days.
     *
     * The month grid asks "what does 11月 look like"; the week view asks the
     * same question about seven days, which may straddle two months. One
     * expansion routine answers both, so the two views cannot drift.
     */
    case "range.get": {
      const from = dayStart(String(params?.from ?? dayKey(/* @__PURE__ */ new Date())));
      const to = dayEnd(String(params?.to ?? dayKey(/* @__PURE__ */ new Date())));
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new Error("\u65E5\u671F\u8981\u5199\u6210 2026-09-30 \u8FD9\u6837");
      }
      if (to < from) throw new Error("from \u6BD4 to \u8FD8\u665A");
      return { from: dayKey(from), to: dayKey(to), byDay: occurrencesBetween(from, to) };
    }
    case "item.save": {
      const item = saveItem(params);
      await save();
      render();
      return { ok: true, id: item.id };
    }
    case "item.remove": {
      state.items = state.items.filter((i) => i.id !== String(params?.id));
      await save();
      render();
      return { ok: true };
    }
    case "item.toggle": {
      const item = state.items.find((i) => i.id === String(params?.id));
      if (!item) throw new Error("\u6CA1\u6709\u8FD9\u6761\u4E8B\u9879");
      const key = String(params?.occurrenceKey ?? currentOccurrenceKey(item, /* @__PURE__ */ new Date()));
      setCompletion(item, key, !item.completions.includes(key));
      await save();
      render();
      return { ok: true };
    }
    case "run.rerun":
      await rerun(String(params?.key));
      return { ok: true };
    case "run.clear":
      state.runs = [];
      await save();
      render();
      return { ok: true };
    default:
      throw new Error(`unknown ui request: ${method}`);
  }
}
__name(onUiRequest, "onUiRequest");
plugin({
  async onInit(context) {
    ctx = context;
    await load();
    render();
    await tick();
  },
  async onPanelMounted() {
    render();
    const due = buildView(/* @__PURE__ */ new Date()).missed.length;
    if (due > 0) await ctx.setBadge(PANEL, due);
  },
  onTool,
  onRequest(_panelId, method, params) {
    return onUiRequest(method, params);
  }
});

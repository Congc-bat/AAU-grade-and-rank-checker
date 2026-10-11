// ==UserScript==
// @name         安农排名一键查
// @namespace    ahau-grade-helper
// @version      1.2.1
// @description  在“我的成绩 / 学生成绩单”页面添加“一键查询成绩”按钮：一次抓取全部学期课程成绩与绩点，汇总全程 + 各学期 GPA、专业排名，支持搜索、只看不及格、复制摘要、导出 CSV。
// @author       @ahau_yifly
// @license      MIT
// @match        *://*.ahau.edu.cn/*for-std/grade/sheet*
// @match        *://ahau.edu.cn/*for-std/grade/sheet*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 适用页面：安徽农业大学教务系统（EAMS）中路径包含 /for-std/grade/sheet 的
 *          “学生成绩 / 我的成绩”页面。
 *   直接访问：https://bkjw.ahau.edu.cn/student/for-std/grade/sheet/semester-index/<学号>
 *   校内 VPN：https://myvpn.ahau.edu.cn/http/<编码>/student/for-std/grade/sheet/...（可能位于 iframe 内）
 *   因此匹配规则只限定 ahau.edu.cn 后缀，不写死子域名与路径前缀；脚本会按当前网址
 *   自动推算接口根路径（VPN 会加一层代理前缀，写死 /student 会请求不到）。
 *
 * 工作原理（全部使用页面自身的接口，不修改任何数据）：
 *   1. 直接读取页面内联脚本里的 var gpaSemesterModel / var semesterIdsubMap
 *      —— 这就是页面右上角“全程 GPA、专业排名、学分”那一段数据；
 *   2. 逐个学期调用 GET {CONTEXT_PATH}/for-std/grade/sheet/info/{学号}?semester={学期}
 *      —— 这是页面自己画成绩表用的接口，返回该学期所有课程的成绩明细；
 *   3. 调用 GET {CONTEXT_PATH}/for-std/grade/sheet/get-not-retake-grade/{学号}
 *      —— 判断哪些课程是重修，用于标记“重修”。
 *   以上全部是只读的 GET 请求。
 */

(function () {
  'use strict';

  /* ============================ 配置 ============================ */

  var CONFIG = {
    cachePrefix: 'anau_grade_cache_v1_', // 成绩缓存
    autoKey: 'anau_grade_auto_query',    // “打开页面自动查询”开关
    cacheTtl: 12 * 60 * 60 * 1000,       // 缓存有效期：12 小时
    concurrency: 3,                      // 并发请求数（不要调太高）
    brand: '@ahau_yifly'                 // 界面上显示的作者标签，改这一行即可更换
  };

  var CTX = (typeof window.CONTEXT_PATH === 'string' && window.CONTEXT_PATH) ? window.CONTEXT_PATH : '/student';
  var SHEET_PATH = '/for-std/grade/sheet';

  /**
   * 接口根路径候选（按优先级）：
   *   1. 按当前网址推算：VPN 访问时形如 /http/<编码>/student/for-std/grade/sheet，
   *      直接访问时就是 /student/for-std/grade/sheet；
   *   2. 页面自己的 CONTEXT_PATH（window.CONTEXT_PATH）。
   * 第一个请求会依次尝试，哪个通就记住哪个。
   */
  function candidateBases() {
    var bases = [];
    var idx = location.pathname.indexOf(SHEET_PATH);
    if (idx >= 0) bases.push(location.pathname.slice(0, idx) + SHEET_PATH);
    var ctxBase = CTX + SHEET_PATH;
    if (bases.indexOf(ctxBase) < 0) bases.push(ctxBase);
    return bases;
  }

  // ======== 纯逻辑开始（可在 Node 中单独测试，不依赖 DOM） ========

  /**
   * 从源码里找到 `var xxx = { ... };` 的对象字面量并原样返回（大括号配对，跳过字符串/注释）。
   * 页面里的 gpaSemesterModel 是 function 作用域变量，抓不到 window，所以只能从脚本文本里取。
   */
  function findObjectLiteral(source, varName) {
    if (!source || !varName) return null;
    var re = new RegExp('(?:var|let|const)\\s+' + varName + '\\s*=\\s*');
    var m = re.exec(source);
    if (!m) return null;

    var i = m.index + m[0].length;
    while (i < source.length && /\s/.test(source.charAt(i))) i++;
    if (source.charAt(i) !== '{') return null;

    var start = i;
    var depth = 0;
    var quote = null;
    var inLineComment = false;
    var inBlockComment = false;

    for (; i < source.length; i++) {
      var ch = source.charAt(i);
      var next = source.charAt(i + 1);

      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; i++; }
        continue;
      }
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * 解析 JS 对象字面量（支持单引号、不带引号的键、数字键、\uXXXX 转义等）。
   * 之所以自己写解析器而不用 new Function：部分教务系统页面带 CSP 限制 eval，
   * 那样解析会静默失败，表现就是“GPA 和排名都读不出来”。
   */
  function parseJsLiteral(input) {
    var s = String(input == null ? '' : input);
    var n = 0;

    function fail(msg) { throw new Error(msg + ' @' + n); }
    function ws() { while (n < s.length && /\s/.test(s.charAt(n))) n++; }

    function parseString() {
      var quote = s.charAt(n++);
      var out = '';
      while (n < s.length) {
        var ch = s.charAt(n++);
        if (ch === '\\') {
          var e = s.charAt(n++);
          if (e === 'u') { out += String.fromCharCode(parseInt(s.substr(n, 4), 16)); n += 4; }
          else if (e === 'x') { out += String.fromCharCode(parseInt(s.substr(n, 2), 16)); n += 2; }
          else if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === 'v') out += '\v';
          else out += e;
          continue;
        }
        if (ch === quote) return out;
        out += ch;
      }
      fail('字符串没有闭合');
    }

    function parseNumber() {
      var m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(n));
      if (!m) fail('数字格式错误');
      n += m[0].length;
      return Number(m[0]);
    }

    function parseArray() {
      var out = [];
      n++;
      ws();
      if (s.charAt(n) === ']') { n++; return out; }
      for (;;) {
        out.push(parseValue());
        ws();
        if (s.charAt(n) === ',') { n++; continue; }
        if (s.charAt(n) === ']') { n++; return out; }
        fail('数组格式错误');
      }
    }

    function parseObject() {
      var out = {};
      n++;
      ws();
      if (s.charAt(n) === '}') { n++; return out; }
      for (;;) {
        ws();
        var key;
        var c = s.charAt(n);
        if (c === '"' || c === "'") {
          key = parseString();
        } else {
          var km = /^[^:\s,{}[\]]+/.exec(s.slice(n));
          if (!km) fail('对象的键格式错误');
          key = km[0];
          n += km[0].length;
        }
        ws();
        if (s.charAt(n) !== ':') fail('对象缺少冒号');
        n++;
        out[key] = parseValue();
        ws();
        if (s.charAt(n) === ',') { n++; continue; }
        if (s.charAt(n) === '}') { n++; return out; }
        fail('对象格式错误');
      }
    }

    function parseValue() {
      ws();
      var c = s.charAt(n);
      if (c === '{') return parseObject();
      if (c === '[') return parseArray();
      if (c === '"' || c === "'") return parseString();
      if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
      if (s.substr(n, 4) === 'true') { n += 4; return true; }
      if (s.substr(n, 5) === 'false') { n += 5; return false; }
      if (s.substr(n, 4) === 'null') { n += 4; return null; }
      var m = /^[A-Za-z_$][\w$]*/.exec(s.slice(n)); // new Date(...) 之类的兜底
      if (m) { n += m[0].length; return null; }
      fail('无法识别的字符 ' + c);
    }

    return parseValue();
  }

  /** 把字面量解析成对象；自带解析器失败时退回 new Function（兼容极少数特殊写法）。 */
  function evalObjectLiteral(literal) {
    if (!literal) return null;
    try {
      return parseJsLiteral(literal); // 优先用自带解析器，不受页面 CSP 限制
    } catch (e) {
      try {
        /* eslint-disable no-new-func */
        return (new Function('"use strict"; return (' + literal + ');'))();
      } catch (e2) {
        return null;
      }
    }
  }

  /** 取出页面里的 gpaSemesterModel 与 semesterIdsubMap。 */
  function extractPageModels(source) {
    return {
      model: evalObjectLiteral(findObjectLiteral(source, 'gpaSemesterModel')),
      subMap: evalObjectLiteral(findObjectLiteral(source, 'semesterIdsubMap'))
    };
  }

  /** 从源码里取学号，即页面里形如 var studentId = <数字>; 的那一句 */
  function extractStudentId(source) {
    if (!source) return null;
    var m = /(?:var|let|const)\s+studentId\s*=\s*(\d+)/.exec(source);
    return m ? m[1] : null;
  }

  /** 从源码里取学期列表：var semesters = JSON.parse('[...]'); */
  function extractSemesters(source) {
    if (!source) return [];
    var m = /(?:var|let|const)\s+semesters\s*=\s*JSON\.parse\(\s*('[^']*'|"[^"]*")\s*\)/.exec(source);
    if (!m) return [];
    var jsonText = null;
    try {
      jsonText = parseJsLiteral(m[1]);
    } catch (e) {
      return [];
    }
    try {
      var list = JSON.parse(jsonText);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  /** 页面里的学期统计：优先 semesterIdsubMap，缺失时退回 gpaSemesterModel.gpaSemesterSubs / gpaSemesterSubStr。 */
  function buildSubMap(model, subMap) {
    var out = {};
    function put(item, key) {
      if (!item) return;
      var id = item.semesterId != null ? item.semesterId
        : (item.semesterAssoc && item.semesterAssoc.id != null ? item.semesterAssoc.id : null);
      if (id == null) id = key; // 页面变体里条目可能没写 semesterId，就用外层键
      if (id == null) return;
      if (out[id] == null || out[String(id)] == null) out[id] = item;
    }

    if (subMap && typeof subMap === 'object') {
      Object.keys(subMap).forEach(function (k) { put(subMap[k], k); });
    }

    if (model) {
      var subs = model.gpaSemesterSubs;
      if (!Array.isArray(subs) && typeof model.gpaSemesterSubStr === 'string' && model.gpaSemesterSubStr) {
        try {
          subs = JSON.parse(model.gpaSemesterSubStr);
        } catch (e) {
          subs = evalObjectLiteral(model.gpaSemesterSubStr);
        }
      }
      if (Array.isArray(subs)) subs.forEach(put);
    }
    return out;
  }

  /** 某学期是否拿到了排名/GPA 统计。 */
  function hasRank(info) {
    return !!(info && (info.majorRank != null || info.gpa != null));
  }

  /** 是否为纯数字成绩（百分制）。 */
  function isNumericScore(v) {
    if (v === null || v === undefined) return false;
    var s = String(v).trim();
    return s !== '' && /^-?\d+(\.\d+)?$/.test(s);
  }

  /** 判断一条成绩是否不及格。 */
  function isFail(record) {
    if (!record || !record.published) return false;
    if (isNumericScore(record.score)) return Number(record.score) < 60;
    if (record.passed === false) return true;
    return !!(record.score && /不及格|不合格|未通过/.test(record.score));
  }

  /** 把接口返回的一条成绩整理成统一结构。 */
  function normalizeGradeItem(item, ctx) {
    item = item || {};
    ctx = ctx || {};
    var published = !!item.published;
    var credits = item.minorCourseCredits != null ? item.minorCourseCredits
      : (item.credits != null ? item.credits : null);
    var score = (published && item.gaGrade != null && item.gaGrade !== '') ? String(item.gaGrade) : null;
    var gp = (published && item.gp != null && item.gp !== '') ? item.gp : null;

    var record = {
      id: item.id,
      semesterId: ctx.semesterId != null ? ctx.semesterId : null,
      semesterName: ctx.semesterName || '',
      courseCode: item.courseCode || '',
      courseName: item.courseName || item.courseNameEn || '(未命名课程)',
      minorCourseName: item.minorCourseName || '',
      credits: credits,
      gp: gp,
      score: score,
      gradeDetail: item.gradeDetail != null ? String(item.gradeDetail) : '',
      fillAGrace: item.fillAGrace != null ? String(item.fillAGrace) : '',
      published: published,
      passed: item.passed,
      courseType: item.courseType || '',
      courseTaxon: item.courseTaxon || '',
      courseProperty: item.courseProperty || '',
      compulsory: item.compulsory,
      retake: !!(ctx.retakeIds && ctx.retakeIds.length && ctx.retakeIds.indexOf(item.id) < 0)
    };
    record.failed = isFail(record);
    return record;
  }

  /** 把某个学期的接口返回摊平成课程数组。 */
  function flattenSemestersResponse(res, meta, retakeIds) {
    var out = [];
    if (!res) return out;
    meta = meta || {};
    var gradeMap = res.semesterId2studentGrades || res.semesterId2StudentGrades || {};
    var semesters = Array.isArray(res.semesters) ? res.semesters.slice() : [];

    if (!semesters.length) {
      Object.keys(gradeMap).forEach(function (key) {
        semesters.push({ id: key });
      });
    }

    semesters.forEach(function (sem) {
      var sid = sem.id;
      var list = gradeMap[sid] || gradeMap[String(sid)] || [];
      if (!Array.isArray(list)) list = [];
      var name = (meta[sid] && meta[sid].name) || sem.nameZh || sem.name || ('学期 ' + sid);
      list.forEach(function (item) {
        out.push(normalizeGradeItem(item, {
          semesterId: sid,
          semesterName: name,
          retakeIds: retakeIds
        }));
      });
    });
    return out;
  }

  /** 统计已出成绩的课程：门数、学分、不及格、加权平均分。 */
  function computeCourseStats(courses) {
    var stats = {
      courseCount: 0,
      publishedCount: 0,
      creditSum: 0,
      failCount: 0,
      failCredits: 0,
      weightedScore: null
    };
    var scoreWeight = 0;
    var scoreSum = 0;

    (courses || []).forEach(function (c) {
      stats.courseCount++;
      if (!c.published) return;
      stats.publishedCount++;
      var credit = Number(c.credits);
      if (!isNaN(credit)) stats.creditSum += credit;
      if (c.failed) {
        stats.failCount++;
        if (!isNaN(credit)) stats.failCredits += credit;
      }
      if (isNumericScore(c.score) && !isNaN(credit) && credit > 0) {
        scoreSum += Number(c.score) * credit;
        scoreWeight += credit;
      }
    });

    stats.creditSum = Math.round(stats.creditSum * 100) / 100;
    stats.failCredits = Math.round(stats.failCredits * 100) / 100;
    if (scoreWeight > 0) stats.weightedScore = Math.round((scoreSum / scoreWeight) * 100) / 100;
    return stats;
  }

  /** 取某学期的 GPA / 排名信息。 */
  function semesterInfoOf(subMap, semesterId) {
    if (!subMap) return null;
    return subMap[semesterId] || subMap[String(semesterId)] || null;
  }

  /** “2025-2026学年第2学期” -> “2025-2026-2” */
  function shortSemesterName(name) {
    if (!name) return '';
    return String(name)
      .replace(/学年第\s*(\d+)\s*学期/, '-$1')
      .replace(/\s+/g, '')
      .replace(/(\d{4}-\d{4})(-\d)$/, '$1$2');
  }

  function formatNum(v, digits) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(v);
    if (isNaN(n)) return String(v);
    var d = digits == null ? 2 : digits;
    return String(Math.round(n * Math.pow(10, d)) / Math.pow(10, d));
  }

  function csvEscape(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * 成绩明细（gradeDetail）里带的是 HTML，例如
   * <span class="subGradeProcess" data-lessonId="5547768">平时成绩 60</span>…
   * 原页面直接当 HTML 插入，这里转成纯文本，避免表格里出现一堆标签源码。
   */
  function detailToText(html) {
    if (html == null) return '';
    var s = String(html);
    if (s.indexOf('<') < 0) return s.trim();
    var parts = s
      .replace(/<br\s*\/?>/gi, '\u0001')
      .replace(/<\/(span|div|p|li|td)>/gi, '\u0001')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .split('\u0001')
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return t !== ''; });
    return parts.join(' · ');
  }

  /** 导出 CSV（含 BOM，Excel 直接打开不乱码）。 */
  function toCsv(courses, ctx) {
    ctx = ctx || {};
    var subMap = ctx.subMap || {};
    var headCount = ctx.majorHeadCount != null ? ctx.majorHeadCount : '';
    var head = ['学期', '学期GPA', '学期专业排名', '专业人数', '课程代码', '课程名称', '学分', '绩点', '成绩', '是否及格', '成绩明细', '是否重修', '课程类别', '课程分类', '是否必修'];
    var lines = [head.map(csvEscape).join(',')];
    (courses || []).forEach(function (c) {
      var info = semesterInfoOf(subMap, c.semesterId);
      lines.push([
        c.semesterName,
        info && info.gpa != null ? info.gpa : '',
        info && info.majorRank != null ? info.majorRank : '',
        headCount,
        c.courseCode,
        c.courseName + (c.minorCourseName ? '（' + c.minorCourseName + '）' : ''),
        c.credits == null ? '' : c.credits,
        c.gp == null ? '' : c.gp,
        c.score == null ? '' : c.score,
        c.published ? (c.failed ? '不及格' : '及格') : '未公布',
        detailToText(c.gradeDetail),
        c.retake ? '重修' : '',
        c.courseType,
        c.courseTaxon,
        c.compulsory === true ? '必修' : (c.compulsory === false ? '选修' : '')
      ].map(csvEscape).join(','));
    });
    return '\ufeff' + lines.join('\r\n');
  }

  /** 生成可复制的纯文本成绩摘要。 */
  function buildSummaryText(data) {
    var model = data.model || {};
    var subMap = data.subMap || {};
    var semesters = data.semesters || [];
    var stats = data.stats || computeCourseStats(data.courses || []);
    var out = [];

    out.push('学生成绩摘要');
    out.push('统计时间：' + (model.updatedDateTimeStr || '—'));
    out.push('全程平均学分绩点（GPA）：' + formatNum(model.gpa, 2));
    out.push('学院专业全程 GPA 排名：' + (model.majorRank != null ? model.majorRank : '—') +
      '/' + (model.majorHeadCount != null ? model.majorHeadCount : '—'));
    out.push('全程总学分：' + formatNum(model.totalCredits, 1) +
      '（计划内 ' + formatNum(model.inPlanCredits, 1) + ' / 计划外 ' + formatNum(model.outPlanCredits, 1) + '）');
    out.push('已出成绩课程：' + stats.publishedCount + ' 门，学分合计 ' + formatNum(stats.creditSum, 1) +
      '，不及格 ' + stats.failCount + ' 门' +
      (stats.weightedScore != null ? '，加权平均分 ' + formatNum(stats.weightedScore, 2) : ''));
    out.push('');
    out.push('—— 分学期 ——');

    semesters.forEach(function (sem) {
      var info = semesterInfoOf(subMap, sem.id);
      out.push(sem.name + '：GPA ' + formatNum(info && info.gpa, 2) +
        '，专业排名 ' + formatNum(info && info.majorRank, 0) +
        '/' + (model.majorHeadCount != null ? model.majorHeadCount : '—') +
        '，学分 ' + formatNum(info && info.totalCredits, 1) +
        '（计划内 ' + formatNum(info && info.inPlanCredits, 1) + ' / 计划外 ' + formatNum(info && info.outPlanCredits, 1) + '）');
    });

    var fails = (data.courses || []).filter(function (c) { return c.failed; });
    if (fails.length) {
      out.push('');
      out.push('—— 不及格课程 ——');
      fails.forEach(function (c) {
        out.push(shortSemesterName(c.semesterName) + ' ' + c.courseName + '：' + c.score +
          '（' + formatNum(c.credits, 1) + ' 学分）');
      });
    }
    if (data.brand) {
      out.push('');
      out.push(data.brand);
    }
    return out.join('\n');
  }

  /** 按学期分组（学期 id 从新到旧）。 */
  function groupBySemester(courses, semesters) {
    var order = {};
    (semesters || []).forEach(function (s, i) { order[s.id] = i; });
    var map = {};
    (courses || []).forEach(function (c) {
      var key = String(c.semesterId);
      if (!map[key]) map[key] = { id: c.semesterId, name: c.semesterName, courses: [] };
      map[key].courses.push(c);
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      var ia = order[a.id] != null ? order[a.id] : 999;
      var ib = order[b.id] != null ? order[b.id] : 999;
      if (ia !== ib) return ia - ib;
      return Number(b.id) - Number(a.id);
    });
  }

  // ======== 纯逻辑结束 ========

  /* ============================ 通用工具 ============================ */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function mapLimit(items, limit, worker) {
    var results = new Array(items.length);
    var index = 0;
    var running = 0;
    return new Promise(function (resolve) {
      if (!items.length) return resolve(results);
      function next() {
        if (index >= items.length) {
          if (running === 0) resolve(results);
          return;
        }
        var i = index++;
        running++;
        Promise.resolve(worker(items[i], i)).then(function (v) {
          results[i] = v;
        }, function (e) {
          results[i] = { __error: e };
        }).then(function () {
          running--;
          next();
        });
      }
      for (var k = 0; k < Math.min(limit, items.length); k++) next();
    });
  }

  /** 读取页面内所有内联脚本文本 —— gpaSemesterModel 就在这里。 */
  function getInlineScriptText() {
    var text = '';
    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length; i++) {
      text += '\n' + (scripts[i].textContent || '');
    }
    return text;
  }

  function readPageContext() {
    var source = getInlineScriptText();
    var models = extractPageModels(source);

    // 学号：隐藏域 > URL > 脚本文本
    var studentId = null;
    var input = document.querySelector('#studentId');
    if (input && input.value) studentId = String(input.value).trim();
    if (!studentId) {
      var m = /(?:semester-index|grade\/sheet)\/(\d+)/.exec(location.pathname + location.search);
      if (m) studentId = m[1];
    }
    if (!studentId) studentId = extractStudentId(source);

    // 学期列表：源码里的 semesters > 下拉框选项
    var semesters = extractSemesters(source).map(function (s) {
      return { id: s.id, name: s.nameZh || s.name || ('学期 ' + s.id) };
    });
    if (!semesters.length) {
      var select = document.querySelector('#semester');
      if (select) {
        for (var i = 0; i < select.options.length; i++) {
          var opt = select.options[i];
          if (opt.value) semesters.push({ id: Number(opt.value), name: opt.textContent.trim() });
        }
      }
    }
    semesters.sort(function (a, b) { return Number(b.id) - Number(a.id); });

    var subMap = buildSubMap(models.model, models.subMap);

    // 学期名以页面统计里的 semesterName 为准（有些学期不在下拉框里，也能显示出来）
    var known = {};
    semesters.forEach(function (s) { known[s.id] = true; });
    Object.keys(subMap).forEach(function (k) {
      var info = subMap[k];
      if (!known[k]) {
        semesters.push({ id: isNaN(Number(k)) ? k : Number(k), name: info.semesterName || ('学期 ' + k) });
      }
    });
    semesters.sort(function (a, b) { return Number(b.id) - Number(a.id); });

    return { source: source, model: models.model, subMap: subMap, studentId: studentId, semesters: semesters };
  }

  /* ============================ 数据请求 ============================ */

  async function fetchJSON(url) {
    var res = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    var text = await res.text();
    if (/<title>\s*登录页面\s*<\/title>/.test(text)) {
      throw new Error('登录状态已失效，请先登录教务系统再查询');
    }
    if (!res.ok) throw new Error('请求失败：HTTP ' + res.status);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('返回内容不是 JSON（可能是登录失效或接口变更）');
    }
  }

  /**
   * 请求接口。VPN 环境下路径前缀可能和 CONTEXT_PATH 不一致，
   * 因此依次尝试 candidateBases()，命中后记住可用的根路径。
   */
  async function apiGet(relPath, query) {
    var bases = state.baseUrl ? [state.baseUrl] : candidateBases();
    var lastErr = null;
    for (var i = 0; i < bases.length; i++) {
      var url = bases[i] + relPath + (query ? '?' + query : '');
      try {
        var data = await fetchJSON(url);
        state.baseUrl = bases[i];
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('请求失败');
  }

  /**
   * 兜底：页面内联脚本里读不到 GPA / 排名统计时（页面变体、脚本被改写等），
   * 重新拉一次当前页面 HTML 再解析一次。
   */
  async function ensureRankData() {
    if (state.model && Object.keys(state.subMap || {}).length) return false;
    var changed = false;
    try {
      var res = await fetch(location.href, { credentials: 'same-origin' });
      var html = await res.text();
      var models = extractPageModels(html);
      if (!state.model && models.model) { state.model = models.model; changed = true; }
      var subMap = buildSubMap(models.model || state.model, models.subMap);
      if (!Object.keys(state.subMap || {}).length && Object.keys(subMap).length) {
        state.subMap = subMap;
        changed = true;
      }
      if (models.model && !state.studentId) state.studentId = extractStudentId(html);
      if (changed) {
        renderBar();
        if (els.mask) renderAll();
      }
    } catch (e) { /* 拿不到就算了，不影响成绩查询 */ }
    return changed;
  }

  async function fetchAllGrades(studentId, semesters, onProgress) {
    var retakeIds = [];
    try {
      var r = await apiGet('/get-not-retake-grade/' + encodeURIComponent(studentId));
      if (r && Array.isArray(r.notRetakeGradeIds)) retakeIds = r.notRetakeGradeIds;
    } catch (e) { /* 拿不到就算了，只是少个“重修”标记 */ }

    var meta = {};
    semesters.forEach(function (s) { meta[s.id] = s; });

    var done = 0;
    var errors = [];
    var results = await mapLimit(semesters, CONFIG.concurrency, async function (sem) {
      try {
        var data = await apiGet('/info/' + encodeURIComponent(studentId), 'semester=' + encodeURIComponent(sem.id));
        return data;
      } finally {
        done++;
        if (onProgress) onProgress(done, semesters.length);
      }
    });

    var courses = [];
    results.forEach(function (data, i) {
      if (!data || data.__error) {
        errors.push((semesters[i] && semesters[i].name) + '：' + ((data && data.__error && data.__error.message) || '获取失败'));
        return;
      }
      courses = courses.concat(flattenSemestersResponse(data, meta, retakeIds));
    });

    return { courses: courses, errors: errors };
  }

  /* ============================ 样式与界面 ============================ */

  function injectStyles() {
    if (document.getElementById('anau-grade-style')) return;
    var css = [
      '.anau-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;margin:16px 0 10px;padding:12px 16px;',
      'background:linear-gradient(90deg,#f8fbff,#eef4ff);border:1px solid #d8e5f7;border-left:4px solid #2f6fdc;border-radius:8px;font-size:14px;color:#1f2937}',
      '.anau-bar b{font-size:17px}',
      '.anau-bar .anau-bar-item{white-space:nowrap}',
      '.anau-bar .anau-bar-item span{color:#4b5563}',
      '.anau-bar .anau-bar-btns{margin-left:auto;display:flex;gap:8px}',
      '.anau-btn{cursor:pointer;border:none;border-radius:6px;padding:7px 14px;font-size:14px;background:#2f6fdc;color:#fff}',
      '.anau-btn:hover{background:#2559b3}',
      '.anau-btn-ghost{background:#fff;color:#2f6fdc;border:1px solid #b9cdea}',
      '.anau-btn-ghost:hover{background:#f1f6ff}',
      '.anau-mask{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px}',
      '.anau-panel{width:min(1180px,96vw);height:min(88vh,940px);background:#fff;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(15,23,42,.38);font-size:14px;color:#1f2937}',
      '.anau-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #eaeef5;background:#fbfdff}',
      '.anau-title{font-size:17px;font-weight:600}',
      '.anau-brand{display:inline-block;margin-left:8px;padding:2px 9px;border-radius:999px;background:#eef4ff;border:1px solid #cfe0fb;color:#1d4ed8;font-size:12px;font-weight:600;vertical-align:middle}',
      '.anau-brand-inline{color:#6b7280;font-size:12px;white-space:nowrap}',
      '.anau-sub{font-size:12px;color:#6b7280;font-weight:400;margin-left:6px}',
      '.anau-actions{margin-left:auto;display:flex;gap:8px}',
      '.anau-act{cursor:pointer;border:1px solid #d7dfea;background:#fff;color:#334155;border-radius:6px;padding:6px 12px;font-size:13px}',
      '.anau-act:hover{border-color:#2f6fdc;color:#2f6fdc}',
      '.anau-act-close{border:none;font-size:16px;line-height:1;padding:6px 10px;color:#6b7280}',
      '.anau-scroll{flex:1;overflow:auto;padding:16px 18px}',
      '.anau-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:10px;margin-bottom:14px}',
      '.anau-card{border:1px solid #e6ecf5;border-radius:10px;padding:10px 14px;background:#fcfdff}',
      '.anau-card .k{font-size:12px;color:#6b7280}',
      '.anau-card .v{font-size:20px;font-weight:700;color:#1d4ed8;margin-top:2px}',
      '.anau-card .v small{font-size:12px;font-weight:400;color:#9ca3af}',
      '.anau-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}',
      '.anau-chip{cursor:pointer;border:1px solid #dfe6f0;background:#fff;color:#334155;border-radius:999px;padding:5px 12px;font-size:13px}',
      '.anau-chip:hover{border-color:#2f6fdc;color:#2f6fdc}',
      '.anau-chip.is-active{background:#2f6fdc;border-color:#2f6fdc;color:#fff}',
      '.anau-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:10px 12px;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;margin-bottom:12px}',
      '.anau-input{flex:1;min-width:180px;border:1px solid #d7dfea;border-radius:6px;padding:7px 10px;font-size:13px}',
      '.anau-input:focus{outline:none;border-color:#2f6fdc}',
      '.anau-check{display:flex;align-items:center;gap:5px;font-size:13px;color:#475569;cursor:pointer;white-space:nowrap}',
      '.anau-count{margin-left:auto;font-size:12px;color:#6b7280;white-space:nowrap}',
      '.anau-table-area table{width:100%;border-collapse:collapse;font-size:13px}',
      '.anau-table-area th{position:sticky;top:0;background:#f1f5f9;color:#334155;font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid #e2e8f0;z-index:2}',
      '.anau-table-area td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}',
      '.anau-table-area tr.is-fail td{background:#fff5f5}',
      '.anau-group td{background:#eef4ff;font-weight:600;color:#1d4ed8;font-size:13px}',
      '.anau-course-name{font-weight:600;color:#111827}',
      '.anau-course-meta{font-size:11px;color:#9ca3af;margin-top:2px}',
      '.anau-tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;margin-left:6px;vertical-align:middle}',
      '.anau-tag-retake{background:#fff1f0;color:#d4380d;border:1px solid #ffccc7}',
      '.anau-tag-minor{background:#f6ffed;color:#389e0d;border:1px solid #d9f7be}',
      '.anau-score-fail{color:#cf1322;font-weight:700}',
      '.anau-muted{color:#9ca3af}',
      '.anau-foot{border-top:1px solid #eaeef5;padding:10px 18px;font-size:12px;color:#6b7280;display:flex;flex-wrap:wrap;gap:6px 18px;background:#fbfdff}',
      '.anau-ranks{margin-bottom:14px}',
      '.anau-rank-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin-bottom:6px}',
      '.anau-rank-title{font-size:15px;font-weight:600;color:#1f2937}',
      '.anau-rank-note{font-size:12px;color:#6b7280}',
      '.anau-rank-table{width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e6ecf5;border-radius:8px;overflow:hidden}',
      '.anau-rank-table th{background:#f1f5f9;color:#334155;text-align:left;padding:7px 10px;font-weight:600;border-bottom:1px solid #e2e8f0}',
      '.anau-rank-table td{padding:7px 10px;border-bottom:1px solid #f1f5f9}',
      '.anau-rank-table tr:last-child td{border-bottom:none}',
      '.anau-rank-table tr.anau-rank-all td{background:#f5f9ff;font-weight:600;color:#1d4ed8}',
      '.anau-rank-no{color:#cf1322;font-weight:700}',
      '.anau-rank-table tr.anau-rank-all .anau-rank-no{color:#cf1322}',
      '.anau-sem-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 16px;margin:0 0 8px;padding:9px 12px;background:#f5f9ff;border:1px solid #dbe7f7;border-radius:8px;font-size:13px;color:#334155}',
      '.anau-sem-name{font-weight:600;color:#1d4ed8}',
      '.anau-sem-item b{color:#cf1322}',
      '.anau-warn{color:#b45309}',
      '.anau-empty{padding:36px;text-align:center;color:#94a3b8}'
    ].join('');
    var style = document.createElement('style');
    style.id = 'anau-grade-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ============================ 主流程 ============================ */

  var state = {
    studentId: null,
    semesters: [],
    model: null,
    subMap: null,
    courses: [],
    errors: [],
    loading: false,
    loadedAt: null,
    fromCache: false,
    baseUrl: null,
    filter: { semesterId: 'all', keyword: '', onlyFail: false, hideUnpublished: false }
  };

  var els = {};

  function cacheKey() {
    return CONFIG.cachePrefix + (state.studentId || 'unknown');
  }

  function saveCache() {
    if (!state.studentId || !state.courses.length) return;
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({
        savedAt: Date.now(),
        studentId: state.studentId,
        semesters: state.semesters,
        courses: state.courses,
        loadedAt: state.loadedAt
      }));
    } catch (e) { /* 缓存失败无所谓 */ }
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(cacheKey());
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.courses) || !data.courses.length) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function timeText(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- 页面上的按钮与摘要条 ---------- */

  function makeButton(id, text, cls) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = cls || 'btn btn-primary';
    btn.textContent = text;
    btn.style.marginRight = '6px';
    return btn;
  }

  function injectPageUI() {
    if (!els.queryBtn || !document.body.contains(els.queryBtn)) {
      var slot = document.querySelector('.page-header-slot') || document.querySelector('.page-header');
      var btn = makeButton('anau-grade-btn', '📊 一键查询成绩', 'btn btn-primary');
      btn.addEventListener('click', function () { openPanel(); });
      els.queryBtn = btn;
      if (slot) {
        var printBtn = document.getElementById('print');
        if (printBtn && printBtn.parentNode === slot) slot.insertBefore(btn, printBtn);
        else slot.appendChild(btn);
      } else {
        btn.style.position = 'fixed';
        btn.style.right = '24px';
        btn.style.bottom = '24px';
        btn.style.zIndex = '9999';
        btn.style.boxShadow = '0 6px 18px rgba(0,0,0,.24)';
        btn.style.marginRight = '0';
        document.body.appendChild(btn);
      }
    }

    if (!els.bar || !document.body.contains(els.bar)) {
      var bar = document.createElement('div');
      bar.className = 'anau-bar';
      els.bar = bar;
      var anchor = document.querySelector('.table-wrapper') || document.querySelector('form.form-horizontal');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor);
      else document.body.insertBefore(bar, document.body.firstChild);
    }
    renderBar();
  }

  function renderBar() {
    if (!els.bar) return;
    var model = state.model;
    var parts = [];

    if (model) {
      parts.push('<span class="anau-bar-item"><span>全程 GPA：</span><b>' + esc(formatNum(model.gpa, 2)) + '</b></span>');
      parts.push('<span class="anau-bar-item"><span>学院专业全程排名：</span><b>' +
        esc(String(model.majorRank != null ? model.majorRank : '—')) + '/' + esc(String(model.majorHeadCount != null ? model.majorHeadCount : '—')) + '</b></span>');
      parts.push('<span class="anau-bar-item"><span>总学分：</span><b>' + esc(formatNum(model.totalCredits, 1)) + '</b></span>');
      parts.push('<span class="anau-bar-item"><span>计划内：</span>' + esc(formatNum(model.inPlanCredits, 1)) + '</span>');
      parts.push('<span class="anau-bar-item"><span>计划外：</span>' + esc(formatNum(model.outPlanCredits, 1)) + '</span>');
      parts.push('<span class="anau-bar-item"><span>统计时间：</span>' + esc(model.updatedDateTimeStr || '—') + '</span>');
    } else {
      parts.push('<span class="anau-bar-item anau-muted">未读取到页面 GPA 统计，可点击右侧按钮直接查询各科成绩</span>');
    }

    els.bar.innerHTML = parts.join('') +
      '<span class="anau-bar-btns">' +
      '<span class="anau-brand-inline">' + esc(CONFIG.brand) + '</span>' +
      '<button type="button" class="anau-btn anau-btn-ghost" data-role="bar-open">查看成绩明细</button>' +
      '</span>';
    var open = els.bar.querySelector('[data-role="bar-open"]');
    if (open) open.addEventListener('click', function () { openPanel(); });
  }

  /* ---------- 弹窗面板 ---------- */

  function ensurePanel() {
    if (els.mask) return els.mask;
    injectStyles();

    var mask = document.createElement('div');
    mask.className = 'anau-mask';
    mask.innerHTML =
      '<div class="anau-panel" role="dialog" aria-modal="true" aria-label="成绩一键查询">' +
      '  <div class="anau-head">' +
      '    <div class="anau-title">📊 成绩一键查询<span class="anau-brand">' + esc(CONFIG.brand) + '</span>' +
      '<span class="anau-sub" data-role="subtitle"></span></div>' +
      '    <div class="anau-actions">' +
      '      <button type="button" class="anau-act" data-role="refresh">重新查询</button>' +
      '      <button type="button" class="anau-act" data-role="copy">复制摘要</button>' +
      '      <button type="button" class="anau-act" data-role="csv">导出 CSV</button>' +
      '      <button type="button" class="anau-act anau-act-close" data-role="close">✕</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="anau-scroll">' +
      '    <div class="anau-overview" data-role="overview"></div>' +
      '    <div class="anau-ranks" data-role="ranks"></div>' +
      '    <div class="anau-chips" data-role="chips"></div>' +
      '    <div class="anau-toolbar">' +
      '      <input class="anau-input" data-role="search" type="search" placeholder="搜索课程名称 / 课程代码">' +
      '      <label class="anau-check"><input type="checkbox" data-role="onlyFail"> 只看不及格</label>' +
      '      <label class="anau-check"><input type="checkbox" data-role="hideUnpublished"> 隐藏未公布成绩</label>' +
      '      <label class="anau-check"><input type="checkbox" data-role="auto"> 打开页面自动查询</label>' +
      '      <span class="anau-count" data-role="count"></span>' +
      '    </div>' +
      '    <div class="anau-table-area" data-role="tableArea"></div>' +
      '  </div>' +
      '  <div class="anau-foot" data-role="foot"></div>' +
      '</div>';
    document.body.appendChild(mask);

    els.mask = mask;
    els.panel = mask.querySelector('.anau-panel');
    ['subtitle', 'overview', 'ranks', 'chips', 'search', 'onlyFail', 'hideUnpublished', 'auto', 'count', 'tableArea', 'foot']
      .forEach(function (key) { els[key] = mask.querySelector('[data-role="' + key + '"]'); });

    mask.addEventListener('click', function (e) {
      if (e.target === mask) closePanel();
    });
    mask.querySelector('[data-role="close"]').addEventListener('click', closePanel);
    mask.querySelector('[data-role="refresh"]').addEventListener('click', function () { runQuery(true); });
    mask.querySelector('[data-role="copy"]').addEventListener('click', copySummary);
    mask.querySelector('[data-role="csv"]').addEventListener('click', exportCsv);

    els.search.addEventListener('input', function () {
      state.filter.keyword = els.search.value.trim();
      renderTable();
    });
    els.onlyFail.addEventListener('change', function () {
      state.filter.onlyFail = els.onlyFail.checked;
      renderTable();
    });
    els.hideUnpublished.addEventListener('change', function () {
      state.filter.hideUnpublished = els.hideUnpublished.checked;
      renderTable();
    });
    els.auto.checked = localStorage.getItem(CONFIG.autoKey) === '1';
    els.auto.addEventListener('change', function () {
      localStorage.setItem(CONFIG.autoKey, els.auto.checked ? '1' : '0');
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && els.mask && els.mask.style.display !== 'none') closePanel();
    });

    return mask;
  }

  function openPanel() {
    injectStyles();
    var mask = ensurePanel();
    mask.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    if (!state.courses.length) {
      var cached = loadCache();
      if (cached) {
        state.courses = cached.courses;
        state.semesters = cached.semesters && cached.semesters.length ? cached.semesters : state.semesters;
        state.loadedAt = cached.loadedAt || cached.savedAt;
        state.fromCache = true;
        renderAll();
      }
    }
    if (!state.courses.length) runQuery(false);
    else {
      ensureRankData(); // 缓存打开时也补一次排名统计
      renderAll();
    }
  }

  function closePanel() {
    if (els.mask) els.mask.style.display = 'none';
    document.body.style.overflow = '';
  }

  /* ---------- 查询 ---------- */

  async function runQuery(force) {
    if (state.loading) return;
    if (!state.studentId) {
      state.errors = ['没有识别到学号，请确认当前是“我的成绩”页面'];
      ensurePanel();
      renderAll();
      return;
    }
    if (!state.semesters.length) {
      state.errors = ['没有识别到学期列表，请刷新页面后重试'];
      ensurePanel();
      renderAll();
      return;
    }

    state.loading = true;
    state.errors = [];
    state.fromCache = false;
    state.baseUrl = null; // 每次查询重新探测接口根路径，兼容 VPN 路径变化
    ensurePanel();
    els.mask.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    renderAll();

    try {
      await ensureRankData(); // 先补一次排名统计，保证面板里的排名有数
      var result = await fetchAllGrades(state.studentId, state.semesters, function (done, total) {
        if (els.subtitle) els.subtitle.textContent = '正在查询… ' + done + '/' + total;
      });
      state.courses = result.courses;
      state.errors = result.errors;
      state.loadedAt = Date.now();
      if (result.courses.length) saveCache();
    } catch (e) {
      state.errors = [e && e.message ? e.message : String(e)];
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  /* ---------- 渲染 ---------- */

  function renderAll() {
    if (!els.mask) return;
    renderOverview();
    renderRankTable();
    renderChips();
    renderTable();
    renderFoot();

    if (els.subtitle) {
      var bits = [];
      if (state.loading) bits.push('正在查询…');
      else if (state.fromCache) bits.push('缓存数据（' + timeText(state.loadedAt) + '）');
      else if (state.loadedAt) bits.push('已更新 ' + timeText(state.loadedAt));
      els.subtitle.textContent = bits.join(' · ');
    }
  }

  function renderOverview() {
    if (!els.overview) return;
    var m = state.model || {};
    var stats = computeCourseStats(state.courses);
    var latest = latestSemesterInfo();
    var cards = [
      { k: '全程平均学分绩点 GPA', v: formatNum(m.gpa, 2) },
      { k: '学院专业全程 GPA 排名', v: rankText(m.majorRank, m.majorHeadCount) },
      { k: '全程总学分', v: formatNum(m.totalCredits, 1) },
      { k: '计划内 / 计划外学分', v: formatNum(m.inPlanCredits, 1) + ' / ' + formatNum(m.outPlanCredits, 1) },
      { k: '最近学期 GPA 排名', v: latest ? rankText(latest.info.majorRank, m.majorHeadCount) : '—', sub: latest ? latest.sem.name : '' },
      { k: '已出成绩学分（本次抓取）', v: formatNum(stats.creditSum, 1) },
      { k: '不及格', v: stats.failCount + ' 门', sub: stats.failCount ? '共 ' + formatNum(stats.failCredits, 1) + ' 学分' : '' },
      { k: '加权平均分', v: stats.weightedScore != null ? formatNum(stats.weightedScore, 2) : '—' },
      { k: '统计时间', v: esc(m.updatedDateTimeStr || '—') }
    ];
    els.overview.innerHTML = cards.map(function (c) {
      return '<div class="anau-card"><div class="k">' + esc(c.k) + '</div><div class="v">' +
        (c.v == null ? '—' : c.v) + (c.sub ? ' <small>' + esc(c.sub) + '</small>' : '') + '</div></div>';
    }).join('');
  }

  function rankText(rank, headCount) {
    if (rank == null && headCount == null) return '—';
    return (rank == null ? '—' : rank) + ' / ' + (headCount == null ? '—' : headCount);
  }

  /** 有 GPA/排名统计里最新的那个学期。 */
  function latestSemesterInfo() {
    var found = null;
    state.semesters.forEach(function (sem) {
      var info = semesterInfoOf(state.subMap, sem.id);
      if (!hasRank(info)) return;
      if (!found || Number(sem.id) > Number(found.sem.id)) found = { sem: sem, info: info };
    });
    return found;
  }

  /**
   * 排名一览：全程 + 每个学期，直接以表格展示（不靠鼠标悬停提示），
   * 这样“每学期排名 / 全程排名”一打开面板就能看到。
   */
  function renderRankTable() {
    if (!els.ranks) return;
    var m = state.model || {};
    var rows = [];
    var missing = 0;

    if (m.gpa != null || m.majorRank != null) {
      rows.push('<tr class="anau-rank-all"><td>全程（累计）</td><td>' + esc(formatNum(m.gpa, 2)) + '</td><td class="anau-rank-no">' +
        esc(rankText(m.majorRank, m.majorHeadCount)) + '</td><td>' + esc(formatNum(m.totalCredits, 1)) +
        '</td><td>计划内 ' + esc(formatNum(m.inPlanCredits, 1)) + ' / 计划外 ' + esc(formatNum(m.outPlanCredits, 1)) + '</td></tr>');
    }

    state.semesters.forEach(function (sem) {
      var info = semesterInfoOf(state.subMap, sem.id);
      var hasCourses = state.courses.some(function (c) { return String(c.semesterId) === String(sem.id); });
      if (!hasRank(info)) {
        if (!hasCourses) return; // 既没成绩也没统计的学期不占一行
        missing++;
        rows.push('<tr><td>' + esc(sem.name) + '</td><td colspan="4" class="anau-muted">未读取到该学期排名统计</td></tr>');
        return;
      }
      rows.push('<tr><td>' + esc(sem.name) + '</td><td>' + esc(formatNum(info.gpa, 2)) + '</td><td class="anau-rank-no">' +
        esc(rankText(info.majorRank, m.majorHeadCount)) + '</td><td>' + esc(formatNum(info.totalCredits, 1)) +
        '</td><td>计划内 ' + esc(formatNum(info.inPlanCredits, 1)) + ' / 计划外 ' + esc(formatNum(info.outPlanCredits, 1)) + '</td></tr>');
    });

    var title = '排名一览' + (m.majorHeadCount != null ? '（排名分母 = 专业人数 ' + m.majorHeadCount + '）' : '');
    var warn = '';
    if (!rows.length) {
      warn = '<div class="anau-warn">没有读取到排名数据：页面里没有 gpaSemesterModel。请把该页面的 HTML 保存下来发给我，我再适配。</div>';
    } else if (missing) {
      warn = '<div class="anau-warn">有 ' + missing + ' 个学期没有排名统计（页面里就没有，通常是该学期成绩还未统计）。</div>';
    }

    els.ranks.innerHTML = '<div class="anau-rank-head">' +
      '<span class="anau-rank-title">' + esc(title) + '</span>' +
      '<span class="anau-rank-note">数据来自页面统计（每日零时更新）' +
      (m.updatedDateTimeStr ? ' · ' + esc(m.updatedDateTimeStr) : '') + '</span></div>' +
      warn +
      (rows.length ? '<table class="anau-rank-table"><thead><tr><th>范围</th><th>GPA</th><th>专业排名</th><th>学分</th><th>计划内 / 计划外</th></tr></thead><tbody>' +
        rows.join('') + '</tbody></table>' : '');
  }

  function renderChips() {
    if (!els.chips) return;
    var m = state.model || {};
    var html = ['<button type="button" class="anau-chip' + (state.filter.semesterId === 'all' ? ' is-active' : '') + '" data-sid="all">全部学期</button>'];
    state.semesters.forEach(function (sem) {
      var info = semesterInfoOf(state.subMap, sem.id);
      var label = shortSemesterName(sem.name) || sem.name;
      var tip = sem.name + (hasRank(info)
        ? '：GPA ' + formatNum(info.gpa, 2) + '，专业排名 ' + rankText(info.majorRank, m.majorHeadCount)
        : '：该学期没有排名统计');
      // 排名直接写在按钮上，不用鼠标悬停也能看到
      html.push('<button type="button" title="' + esc(tip) + '" class="anau-chip' +
        (String(state.filter.semesterId) === String(sem.id) ? ' is-active' : '') +
        '" data-sid="' + esc(sem.id) + '">' + esc(label) +
        (hasRank(info) ? ' · ' + formatNum(info.gpa, 2) + ' · 第' + esc(String(info.majorRank == null ? '—' : info.majorRank)) + '名' : '') +
        '</button>');
    });
    els.chips.innerHTML = html.join('');
    Array.prototype.forEach.call(els.chips.querySelectorAll('.anau-chip'), function (chip) {
      chip.addEventListener('click', function () {
        state.filter.semesterId = chip.getAttribute('data-sid');
        renderChips();
        renderTable();
      });
    });
  }

  function currentCourses() {
    var f = state.filter;
    return state.courses.filter(function (c) {
      if (f.semesterId !== 'all' && String(c.semesterId) !== String(f.semesterId)) return false;
      if (f.keyword) {
        var k = f.keyword.toLowerCase();
        var hay = (c.courseName + ' ' + c.courseCode + ' ' + c.minorCourseName + ' ' + c.courseType + ' ' + c.courseTaxon).toLowerCase();
        if (hay.indexOf(k) < 0) return false;
      }
      if (f.onlyFail && !c.failed) return false;
      if (f.hideUnpublished && !c.published) return false;
      return true;
    });
  }

  function rowHtml(c) {
    var cls = c.failed ? ' class="is-fail"' : '';
    var scoreCell;
    if (!c.published) scoreCell = '<span class="anau-muted">未公布</span>';
    else scoreCell = '<span class="' + (c.failed ? 'anau-score-fail' : '') + '">' + esc(c.score == null ? '—' : c.score) + '</span>' +
      (c.fillAGrace ? '<span class="anau-score-fail">' + esc(c.fillAGrace) + '</span>' : '');

    var meta = [];
    if (c.courseCode) meta.push('课程代码 ' + c.courseCode);
    if (c.courseType) meta.push(c.courseType);
    if (c.courseTaxon) meta.push(c.courseTaxon);
    if (c.compulsory === true) meta.push('必修');
    else if (c.compulsory === false) meta.push('选修');

    var tags = '';
    if (c.retake) tags += '<span class="anau-tag anau-tag-retake">重修</span>';
    if (c.minorCourseName) tags += '<span class="anau-tag anau-tag-minor">' + esc(c.minorCourseName) + '</span>';

    return '<tr' + cls + '>' +
      '<td><div class="anau-course-name">' + esc(c.courseName) + tags + '</div>' +
      (meta.length ? '<div class="anau-course-meta">' + esc(meta.join(' · ')) + '</div>' : '') + '</td>' +
      '<td>' + esc(c.credits == null ? '—' : formatNum(c.credits, 1)) + '</td>' +
      '<td>' + esc(c.gp == null ? '—' : formatNum(c.gp, 2)) + '</td>' +
      '<td>' + scoreCell + '</td>' +
      '<td>' + esc(detailToText(c.gradeDetail)) + '</td>' +
      '</tr>';
  }

  function tableHtml(courses) {
    var thead = '<thead><tr><th style="width:36%">课程名称</th><th style="width:10%">学分</th>' +
      '<th style="width:10%">绩点</th><th style="width:12%">成绩</th><th style="width:32%">成绩明细</th></tr></thead>';

    if (state.filter.semesterId === 'all') {
      var groups = groupBySemester(courses, state.semesters);
      var m = state.model || {};
      return '<table>' + thead + '<tbody>' + groups.map(function (g) {
        var info = semesterInfoOf(state.subMap, g.id);
        var line = esc(g.name);
        if (hasRank(info)) {
          line += ' · GPA ' + formatNum(info.gpa, 2) +
            ' · 专业排名 ' + rankText(info.majorRank, m.majorHeadCount) +
            ' · 学分 ' + formatNum(info.totalCredits, 1) +
            '（计划内 ' + formatNum(info.inPlanCredits, 1) + ' / 计划外 ' + formatNum(info.outPlanCredits, 1) + '）';
        } else {
          line += ' · <span class="anau-muted">该学期没有排名统计</span>';
        }
        return '<tr class="anau-group"><td colspan="5">' + line + '</td></tr>' +
          g.courses.map(rowHtml).join('');
      }).join('') + '</tbody></table>';
    }

    // 单个学期：在表格上方标明该学期的 GPA 与排名
    var sem = null;
    state.semesters.forEach(function (s) {
      if (String(s.id) === String(state.filter.semesterId)) sem = s;
    });
    var info = semesterInfoOf(state.subMap, state.filter.semesterId);
    var m2 = state.model || {};
    var head = '';
    if (sem || hasRank(info)) {
      head = '<div class="anau-sem-head">' +
        '<span class="anau-sem-name">' + esc(sem ? sem.name : '学期 ' + state.filter.semesterId) + '</span>' +
        (hasRank(info)
          ? '<span class="anau-sem-item">GPA <b>' + esc(formatNum(info.gpa, 2)) + '</b></span>' +
            '<span class="anau-sem-item">专业排名 <b>' + esc(rankText(info.majorRank, m2.majorHeadCount)) + '</b></span>' +
            '<span class="anau-sem-item">学分 <b>' + esc(formatNum(info.totalCredits, 1)) + '</b>（计划内 ' +
            esc(formatNum(info.inPlanCredits, 1)) + ' / 计划外 ' + esc(formatNum(info.outPlanCredits, 1)) + '）</span>'
          : '<span class="anau-sem-item anau-muted">该学期没有排名统计</span>') +
        '</div>';
    }
    return head + '<table>' + thead + '<tbody>' + courses.map(rowHtml).join('') + '</tbody></table>';
  }

  function renderTable() {
    if (!els.tableArea) return;
    var courses = currentCourses();
    var stats = computeCourseStats(courses);

    els.count.textContent = '显示 ' + courses.length + ' 门 / 共 ' + state.courses.length + ' 门' +
      (stats.weightedScore != null ? '，加权平均分 ' + formatNum(stats.weightedScore, 2) : '');

    if (state.loading && !state.courses.length) {
      els.tableArea.innerHTML = '<div class="anau-empty">正在查询各学期成绩，请稍候…</div>';
      return;
    }
    if (!courses.length) {
      els.tableArea.innerHTML = '<div class="anau-empty">' +
        (state.courses.length ? '没有符合筛选条件的课程' : '暂无成绩数据') + '</div>';
      return;
    }
    els.tableArea.innerHTML = tableHtml(courses);
  }

  function renderFoot() {
    if (!els.foot) return;
    var stats = computeCourseStats(state.courses);
    var rankOk = 0;
    var rankMissing = 0;
    state.semesters.forEach(function (sem) {
      var info = semesterInfoOf(state.subMap, sem.id);
      if (hasRank(info)) rankOk++;
      else if (state.courses.some(function (c) { return String(c.semesterId) === String(sem.id); })) rankMissing++;
    });
    var left = '共 ' + stats.courseCount + ' 门课程（已出成绩 ' + stats.publishedCount + ' 门）· 学分合计 ' +
      formatNum(stats.creditSum, 1) + ' · 不及格 ' + stats.failCount + ' 门 · ' +
      '排名数据 ' + rankOk + ' 个学期' + (rankMissing ? '（缺 ' + rankMissing + ' 个）' : '');
    var right = '数据来源：教务系统成绩接口（只读）· GPA / 排名取自页面统计（每日零时更新）' +
      (state.model ? '' : ' · ⚠ 未读到排名');
    var warn = (state.errors || []).length ? '<span class="anau-warn">部分学期获取失败：' + esc(state.errors.join('；')) + '</span>' : '';
    els.foot.innerHTML = '<span>' + esc(left) + '</span><span>' + esc(right) + '</span>' + warn;
  }

  /* ---------- 导出 ---------- */

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  function exportCsv() {
    var courses = currentCourses();
    if (!courses.length) { alert('当前没有可导出的成绩'); return; }
    var tag = state.filter.semesterId === 'all'
      ? '全部学期'
      : (shortSemesterName((state.semesters.filter(function (s) {
        return String(s.id) === String(state.filter.semesterId);
      })[0] || {}).name) || ('学期' + state.filter.semesterId));
    var csv = toCsv(courses, {
      subMap: state.subMap,
      majorHeadCount: (state.model || {}).majorHeadCount
    });
    download('成绩单_' + tag + '_' + new Date().toISOString().slice(0, 10) + '.csv', csv);
  }

  function copySummary() {
    var text = buildSummaryText({
      brand: CONFIG.brand,
      model: state.model,
      subMap: state.subMap,
      semesters: state.semesters,
      courses: state.courses
    });
    var done = function () {
      var old = els.subtitle.textContent;
      els.subtitle.textContent = '摘要已复制 ✓';
      setTimeout(function () { els.subtitle.textContent = old; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { alert(text); }
    ta.remove();
  }

  /* ---------- 启动 ---------- */

  /**
   * 是否应该在本页生效：网址含 /for-std/grade/sheet，
   * 或者页面本身就是成绩单（VPN 可能改写路径，因此再加一层页面特征判断）。
   */
  function isGradeSheetPage() {
    if (location.pathname.indexOf(SHEET_PATH) >= 0) return true;
    if (document.querySelector('#semester') && document.querySelector('.table-wrapper')) return true;
    return /(?:var|let|const)\s+gpaSemesterModel\s*=/.test(getInlineScriptText());
  }

  function init() {
    if (!isGradeSheetPage()) return;
    var ctx = readPageContext();
    state.studentId = ctx.studentId;
    state.semesters = ctx.semesters;
    state.model = ctx.model;
    state.subMap = ctx.subMap;

    injectPageUI();

    // 页面头部有可能是异步渲染的，这里保持按钮存在 30 秒
    var ticks = 0;
    var timer = setInterval(function () {
      ticks++;
      injectPageUI();
      if (ticks > 30) clearInterval(timer);
    }, 1000);

    if (localStorage.getItem(CONFIG.autoKey) === '1') {
      // 等页面自己的初始化弹窗结束再查询，避免和页面抢请求
      sleep(1200).then(function () { runQuery(false); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { sleep(0).then(init); });
  } else {
    init();
  }
})();

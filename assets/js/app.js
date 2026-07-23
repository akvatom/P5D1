import { STORAGE, AXES } from "./config.js";
import { I18N } from "./i18n.js";
import { ProfileScene } from "./scene.js";

async function loadQuestionBank() {
  const url = new URL("../../data/questions.json", import.meta.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load question bank: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

const QUESTION_BANK = await loadQuestionBank();
const TEST_QUESTIONS = QUESTION_BANK.questions;

const state = {
  currentQuestion: 0,
  answers: loadJson(STORAGE.answers, {}),
  profile: loadJson(STORAGE.profile, null),
  testProfile: loadJson(STORAGE.testProfile, null),
  partner: loadJson(STORAGE.partner, null),
  quality: loadJson(STORAGE.quality, null),
  lang: localStorage.getItem(STORAGE.language) === "en" ? "en" : "ru",
  activeView: "test",
  scanner: null,
  scannerRunning: false
};

const els = Object.fromEntries([...document.querySelectorAll("[id]")].map(el => [el.id, el]));


function tr(key, vars = {}) {
  let value = I18N[state.lang]?.[key] ?? I18N.ru[key] ?? key;
  return String(value).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
}

function axisMeta(axis) {
  const source = AXES[axis];
  return {
    ...source,
    name: source.name[state.lang],
    left: source.left[state.lang],
    right: source.right[state.lang]
  };
}

function questionText(question) {
  return question[state.lang] || question.ru;
}

function applyLanguage() {
  document.documentElement.lang = state.lang;
  document.title = tr("pageTitle");
  document.querySelectorAll("[data-i18n]").forEach(element => {
    element.textContent = tr(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(element => {
    element.placeholder = tr(element.dataset.i18nPlaceholder);
  });
  els.langRuBtn.classList.toggle("active", state.lang === "ru");
  els.langEnBtn.classList.toggle("active", state.lang === "en");
  els.questionCountBadge.textContent = tr("questionCount", {count:TEST_QUESTIONS.length});
  renderQuestion();
  updateProfileAvailability();
  if (state.profile) renderProfileView();
  if (state.profile && state.partner) renderComparison();
  profileScene?.refreshLanguage();
  compareScene?.refreshLanguage();
}

function clamp(value, min = -50, max = 50) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : 0));
}

function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function round(value, digits = 0) { const m = 10 ** digits; return Math.round(value * m) / m; }
function format(value, digits = 1) { return Number(value).toFixed(digits).replace(/\.0$/, ""); }
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function loadJson(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function escapeHtml(value) { return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }

function sanitizeProfile(profile, fallbackName = tr("profileDefault")) {
  if (!profile) return null;
  return {
    name: String(profile.name || fallbackName).slice(0, 70),
    x: clamp(profile.x), y: clamp(profile.y), z: clamp(profile.z),
    t: clamp(profile.t), c: clamp(profile.c),
    color: /^#[0-9a-f]{6}$/i.test(profile.color || "") ? profile.color : "#72aaff"
  };
}

state.profile = sanitizeProfile(state.profile, tr("profileDefault"));
state.testProfile = sanitizeProfile(state.testProfile, tr("profileDefault"));
state.partner = sanitizeProfile(state.partner, tr("partnerDefault"));

function derive(profile) {
  const outer = profile.t + 50;
  const safeShare = (profile.c + 50) / 100;
  const inner = outer * safeShare;
  return { outer, inner, risk: outer - inner, safeShare };
}

function profileCode(profile) {
  return `P5D2|${round(profile.x)}|${round(profile.y)}|${round(profile.z)}|${round(profile.t)}|${round(profile.c)}`;
}

function parseProfileCode(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error(tr("enterCode"));

  if (value.startsWith("{")) {
    const parsed = JSON.parse(value);
    return sanitizeProfile(parsed, tr("partnerDefault"));
  }

  const normalized = value.replace(/\s+/g, "");
  let parts;
  if (/^P5D[12]\|/i.test(normalized)) parts = normalized.split("|").slice(1);
  else parts = normalized.split(/[;,|]/);

  if (parts.length !== 5) throw new Error(tr("fiveCoordinates"));
  const nums = parts.map(Number);
  if (nums.some(n => !Number.isFinite(n))) throw new Error(tr("invalidNumbers"));
  return sanitizeProfile({ name: tr("partnerDefault"), x: nums[0], y: nums[1], z: nums[2], t: nums[3], c: nums[4], color: "#ff8ab3" }, tr("partnerDefault"));
}

function answerValue(raw) {
  if (raw === "yes") return 1;
  if (raw === "no") return -1;
  return null;
}

function orientedAnswer(question, raw) {
  const value = answerValue(raw);
  if (value === null) return null;
  return question.reverse ? -value : value;
}

function calculateTestResult() {
  const axes = ["x", "y", "z", "t", "c"];
  const buckets = Object.fromEntries(axes.map(axis => [axis, []]));
  const totals = Object.fromEntries(axes.map(axis => [axis, 0]));
  const subscaleBuckets = {};
  const byId = new Map(TEST_QUESTIONS.map((question, index) => [question.id, { question, index }]));

  TEST_QUESTIONS.forEach((question, index) => {
    if (question.kind !== "score") return;
    totals[question.axis] += 1;
    const oriented = orientedAnswer(question, state.answers[index]);
    if (oriented === null) return;
    buckets[question.axis].push(oriented);
    if (!subscaleBuckets[question.subscale]) subscaleBuckets[question.subscale] = [];
    subscaleBuckets[question.subscale].push(oriented);
  });

  const coverage = Object.fromEntries(axes.map(axis => [axis, buckets[axis].length / Math.max(1, totals[axis])]));
  const score = axis => {
    const values = buckets[axis];
    if (!values.length) return 0;
    return round(values.reduce((sum, value) => sum + value, 0) / values.length * 50);
  };
  const subscales = Object.fromEntries(Object.entries(QUESTION_BANK.subscales || {}).map(([key]) => {
    const values = subscaleBuckets[key] || [];
    const value = values.length ? round(values.reduce((sum, item) => sum + item, 0) / values.length * 50) : null;
    return [key, { value, answered: values.length }];
  }));

  const checkResults = [];
  const consistencyByAxis = Object.fromEntries(axes.map(axis => [axis, []]));
  TEST_QUESTIONS.forEach((question, index) => {
    if (question.kind !== "consistency") return;
    const baseEntry = byId.get(question.compareTo);
    if (!baseEntry) return;
    const check = orientedAnswer(question, state.answers[index]);
    const base = orientedAnswer(baseEntry.question, state.answers[baseEntry.index]);
    if (check === null || base === null) return;
    const matched = check === base ? 1 : 0;
    checkResults.push(matched);
    consistencyByAxis[question.axis].push(matched);
  });
  const consistency = checkResults.length ? round(checkResults.reduce((sum, value) => sum + value, 0) / checkResults.length * 100) : null;
  const axisConsistency = Object.fromEntries(axes.map(axis => {
    const values = consistencyByAxis[axis];
    return [axis, values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) : null];
  }));
  const overallCoverage = axes.reduce((sum, axis) => sum + buckets[axis].length, 0) / axes.reduce((sum, axis) => sum + totals[axis], 0);
  const consistencyFactor = consistency === null ? 0.85 : 0.70 + 0.30 * (consistency / 100);
  const confidence = round(clamp01(overallCoverage * consistencyFactor) * 100);
  const axisConfidence = Object.fromEntries(axes.map(axis => {
    const factor = axisConsistency[axis] === null ? 0.85 : 0.70 + 0.30 * (axisConsistency[axis] / 100);
    return [axis, round(clamp01(coverage[axis] * factor) * 100)];
  }));

  return {
    profile: sanitizeProfile({
      name: tr("profileDefault"),
      x: score("x"), y: score("y"), z: score("z"), t: score("t"), c: score("c"), color: "#72aaff"
    }),
    quality: {
      consistency, validChecks: checkResults.length, coverage, overallCoverage: round(overallCoverage * 100),
      confidence, axisConfidence, axisConsistency, subscales
    }
  };
}

function answerIsSet(index) {
  return Object.prototype.hasOwnProperty.call(state.answers, index);
}

function allQuestionsAnswered() {
  return TEST_QUESTIONS.every((_, index) => answerIsSet(index));
}

function renderQuestion() {
  const question = TEST_QUESTIONS[state.currentQuestion];
  if (!question) return;
  const currentAnswer = state.answers[state.currentQuestion];
  els.questionCounter.textContent = tr("questionCounter", { current: state.currentQuestion + 1, total: TEST_QUESTIONS.length });
  els.questionAxis.textContent = tr("statementLabel");
  els.questionText.textContent = questionText(question);
  els.testProgressBar.style.width = `${((state.currentQuestion + 1) / TEST_QUESTIONS.length) * 100}%`;
  els.prevQuestionBtn.disabled = state.currentQuestion === 0;
  els.nextQuestionBtn.disabled = !answerIsSet(state.currentQuestion);
  els.nextQuestionBtn.textContent = state.currentQuestion === TEST_QUESTIONS.length - 1 ? tr("finish") : tr("next");

  const options = [
    ["yes", tr("answerYes"), "yes"],
    ["no", tr("answerNo"), "no"],
    ["na", tr("answerUnknown"), "unknown"]
  ];
  els.answerOptions.innerHTML = "";
  options.forEach(([value, text, className]) => {
    const wrapper = document.createElement("div");
    wrapper.className = `answer-option ${className}`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "testAnswer";
    input.id = `answer-${value}`;
    input.value = value;
    input.checked = currentAnswer === value;
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = text;
    input.addEventListener("change", () => {
      state.answers[state.currentQuestion] = value;
      saveJson(STORAGE.answers, state.answers);
      els.nextQuestionBtn.disabled = false;
    });
    wrapper.append(input, label);
    els.answerOptions.appendChild(wrapper);
  });
}

function finishTest() {
  if (!allQuestionsAnswered()) return;
  const result = calculateTestResult();
  const minimum = Number(QUESTION_BANK.scoring?.minimum_axis_coverage ?? 0.5);
  const insufficient = Object.entries(result.quality.coverage).filter(([, value]) => value < minimum).map(([axis]) => axis.toUpperCase());
  if (insufficient.length) {
    alert(tr("insufficientCoverage", { axes: insufficient.join(", "), percent: format(minimum * 100, 0) }));
    return;
  }
  state.testProfile = result.profile;
  state.profile = { ...result.profile };
  state.quality = result.quality;
  saveJson(STORAGE.testProfile, state.testProfile);
  saveJson(STORAGE.profile, state.profile);
  saveJson(STORAGE.quality, state.quality);
  updateProfileAvailability();
  renderProfileView();
  showView("profile");
}

function showView(name) {
  if ((name === "profile" || name === "compare") && !state.profile) return;
  state.activeView = name;
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll("[data-view-target]").forEach(button => button.classList.toggle("active", button.dataset.viewTarget === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
  requestAnimationFrame(() => {
    if (name === "profile") profileScene?.resize();
    if (name === "compare") compareScene?.resize();
  });
}

function updateProfileAvailability() {
  const available = Boolean(state.profile);
  document.querySelectorAll('[data-view-target="profile"], [data-view-target="compare"]').forEach(button => { button.disabled = !available; });
  els.headerStatus.textContent = available ? tr("statusProfile", { code: profileCode(state.profile).split("|").slice(1).join(" / ") }) : tr("statusMissing");
}

function valueBand(value) {
  if (value <= -35) return tr("bandExtremeLeft");
  if (value <= -15) return tr("bandModerateLeft");
  if (value < 15) return tr("bandCenter");
  if (value < 35) return tr("bandModerateRight");
  return tr("bandExtremeRight");
}

function axisSummary(axis, value) {
  const meta = axisMeta(axis);
  const direction = value < -10 ? meta.left : value > 10 ? meta.right : tr("balance");
  const descriptions = state.lang === "ru" ? {
    x: value < -10 ? "Энергия чаще восстанавливается через уединение и контролируемую социальную нагрузку." : value > 10 ? "Энергия чаще поддерживается активным внешним взаимодействием и обменом." : "Режим общения может относительно свободно меняться в зависимости от ситуации.",
    y: value < -10 ? "Эмоциональные сигналы воспринимаются интенсивно; стресс может дольше сохраняться внутри системы." : value > 10 ? "Под нагрузкой легче сохраняется управляемость и дистанция от первого эмоционального импульса." : "Чувствительность и устойчивость находятся в относительно гибком равновесии.",
    z: value < -10 ? "Мышление чаще опирается на конкретность, проверяемость и практическую применимость." : value > 10 ? "Мышление чаще строится через гипотезы, абстракции и поиск новых связей." : "Конкретный и абстрактный режимы используются примерно равномерно.",
    t: value < -10 ? "Радиус изменения привычной роли ограничен; длительная подстройка быстро становится нагрузкой." : value > 10 ? "Доступен широкий диапазон временного изменения поведения и распределения ролей." : "Гибкость присутствует, но имеет заметные границы и зависит от контекста.",
    c: value < -10 ? "Часть уступок может сопровождаться внутренним конфликтом или накоплением скрытой цены." : value > 10 ? "Адаптация чаще переживается как собственный выбор без выраженного разрушения границ." : "Цена адаптации зависит от ситуации и качества договорённостей."
  } : {
    x: value < -10 ? "Energy is more often restored through solitude and controlled social exposure." : value > 10 ? "Energy is more often maintained through active external interaction and exchange." : "The preferred level of interaction can change relatively freely with the situation.",
    y: value < -10 ? "Emotional signals are experienced intensely, and stress may remain active for longer." : value > 10 ? "Under pressure, it is easier to remain regulated and separate from the first emotional impulse." : "Sensitivity and stability are in a relatively flexible balance.",
    z: value < -10 ? "Thinking relies more on concreteness, verification, and practical applicability." : value > 10 ? "Thinking relies more on hypotheses, abstractions, and discovering new connections." : "Concrete and abstract modes are used in roughly equal measure.",
    t: value < -10 ? "The available range for changing a familiar role is limited; prolonged adjustment becomes demanding quickly." : value > 10 ? "A wide range of temporary behavioral and role changes is available." : "Flexibility is present but has noticeable limits and depends on context.",
    c: value < -10 ? "Some concessions may involve inner conflict or an accumulating hidden cost." : value > 10 ? "Adaptation is more often experienced as a free choice without pronounced damage to personal boundaries." : "The cost of adaptation depends on the situation and the quality of agreements."
  };
  const position = state.lang === "ru" ? `Текущее положение — ${valueBand(value)} (${format(value,0)}).` : `Current position: ${valueBand(value)} (${format(value,0)}).`;
  return { title: `${meta.short} · ${meta.name}: ${direction}`, text: `${descriptions[axis]} ${position}` };
}

function createMetric(axis, value) {
  const meta = axisMeta(axis);
  return `<div class="metric ${axis}"><div class="label">${escapeHtml(meta.short)} · ${escapeHtml(meta.name)}</div><div class="value">${value > 0 ? "+" : ""}${format(value,0)}</div></div>`;
}

function createScale(axis, value, options = {}) {
  const meta = axisMeta(axis);
  const percent = (value + 50) / 100 * 100;
  const range = options.range;
  const markerColor = options.color || meta.color;
  let rangeHtml = "";
  if (range && Array.isArray(range)) {
    rangeHtml = range.map(([start,end]) => {
      const left = (clamp(start) + 50);
      const width = clamp(end) - clamp(start);
      return `<div class="bar-range" style="left:${left}%;width:${Math.max(0,width)}%"></div>`;
    }).join("");
  }
  return `<div class="profile-scale">
    <div class="profile-scale-head"><span>${escapeHtml(meta.short)} · ${escapeHtml(meta.name)}</span><strong>${value > 0 ? "+" : ""}${format(value,0)}</strong></div>
    <div class="bar">${rangeHtml}<div class="bar-marker" style="left:${percent}%;color:${markerColor};background:${markerColor}"></div></div>
    <div class="scale-poles"><span>−50 · ${escapeHtml(meta.left)}</span><span>+50 · ${escapeHtml(meta.right)}</span></div>
  </div>`;
}

function recommendedIntervals(value, minDiff, maxDiff) {
  const intervals = [];
  const left = [Math.max(-50, value - maxDiff), Math.min(50, value - minDiff)];
  const right = [Math.max(-50, value + minDiff), Math.min(50, value + maxDiff)];
  if (left[0] <= left[1]) intervals.push(left);
  if (right[0] <= right[1]) intervals.push(right);
  return intervals;
}

function intervalText(intervals) {
  return intervals.map(([a,b]) => `[${format(a,0)}; ${format(b,0)}]`).join(tr("rangeOr"));
}

function getRecommendedRanges(profile) {
  return [
    { axis:"x", intervals:recommendedIntervals(profile.x, 10, 30), reason:tr("reasonX") },
    { axis:"y", intervals:recommendedIntervals(profile.y, 10, 30), reason:tr("reasonY") },
    { axis:"z", intervals:[[Math.max(-50,profile.z-15),Math.min(50,profile.z+15)]], reason:tr("reasonZ") },
    { axis:"t", intervals:[[0,50]], reason:tr("reasonT") },
    { axis:"c", intervals:[[10,50]], reason:tr("reasonC") }
  ];
}

function renderProfileView() {
  if (!state.profile) return;
  const profile = state.profile;
  const derived = derive(profile);
  const qualityScore = state.quality?.confidence ?? 0;
  els.profileMetrics.innerHTML = ["x","y","z","t","c"].map(axis => createMetric(axis, profile[axis])).join("") + `<div class="metric"><div class="label">${escapeHtml(tr("qualityLabel"))}</div><div class="value">${format(qualityScore,0)}%</div></div>`;
  els.profileScales.innerHTML = ["x","y","z","t","c"].map(axis => createScale(axis, profile[axis])).join("");
  els.profileSummary.innerHTML = ["x","y","z","t","c"].map(axis => {
    const summary = axisSummary(axis, profile[axis]);
    return `<div class="summary-block"><strong>${escapeHtml(summary.title)}</strong><p>${escapeHtml(summary.text)}</p></div>`;
  }).join("") + `<div class="summary-block"><strong>${escapeHtml(tr("geometryTitle"))}</strong><p>${escapeHtml(tr("geometryText", {outer:format(derived.outer), inner:format(derived.inner), risk:format(derived.risk), share:format(derived.safeShare*100)}))}</p></div>` + (() => {
    const consistency = state.quality?.consistency;
    const coverage = state.quality?.overallCoverage ?? 0;
    return `<div class="summary-block"><strong>${escapeHtml(tr("qualityLabel"))}: ${format(qualityScore,0)}%</strong><p>${escapeHtml(tr("qualitySummary", {confidence:format(qualityScore,0), coverage:format(coverage,0), consistency:consistency === null || consistency === undefined ? "—" : format(consistency,0)}))}</p></div>`;
  })();

  const ranges = getRecommendedRanges(profile);
  els.recommendedRanges.innerHTML = ranges.map(item => {
    const meta = axisMeta(item.axis);
    return `<div class="range-item"><div class="axis" style="color:${meta.color}">${meta.short} · ${escapeHtml(meta.name)}</div><div class="range">${escapeHtml(intervalText(item.intervals))}</div><div class="reason">${escapeHtml(item.reason)}</div></div>`;
  }).join("");

  if (els.qualityBreakdown) {
    els.qualityBreakdown.innerHTML = ["x","y","z","t","c"].map(axis => {
      const meta = axisMeta(axis);
      const coverage = (state.quality?.coverage?.[axis] ?? 0) * 100;
      const confidence = state.quality?.axisConfidence?.[axis] ?? 0;
      return `<div class="quality-row"><div><strong style="color:${meta.color}">${meta.short}</strong><span>${escapeHtml(meta.name)}</span></div><div class="quality-values"><span>${escapeHtml(tr("coverageLabel"))}: ${format(coverage,0)}%</span><b>${format(confidence,0)}%</b></div></div>`;
    }).join("");
  }

  if (els.subscaleBreakdown) {
    const entries = Object.entries(QUESTION_BANK.subscales || {});
    els.subscaleBreakdown.innerHTML = entries.map(([key, metadata]) => {
      const result = state.quality?.subscales?.[key];
      const value = result?.value;
      const axis = metadata.axis;
      const meta = axisMeta(axis);
      const label = metadata[state.lang] || metadata.ru || key;
      const position = value === null || value === undefined ? 50 : value + 50;
      return `<div class="subscale-item"><div class="subscale-head"><span><b style="color:${meta.color}">${meta.short}</b> ${escapeHtml(label)}</span><strong>${value === null || value === undefined ? "—" : `${value > 0 ? "+" : ""}${format(value,0)}`}</strong></div><div class="mini-bar"><i style="left:${position}%;background:${meta.color}"></i></div></div>`;
    }).join("");
  }

  renderQr();
  renderManualEditor();
  profileScene?.setProfiles([{ ...profile, name:tr("you") }], false);
  els.ownCodeCompare.value = profileCode(profile);
  els.ownProfileMini.innerHTML = miniProfileHtml(profile, tr("you"));
}

function renderQr() {
  if (!state.profile) return;
  const code = profileCode(state.profile);
  els.myProfileCode.value = code;
  els.myQrCode.innerHTML = "";
  if (window.QRCode) {
    new window.QRCode(els.myQrCode, { text: code, width: 170, height: 170, colorDark: "#071018", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
  } else {
    els.myQrCode.textContent = tr("qrLoadFailed");
    els.myQrCode.style.color = "#111";
  }
}

function renderManualEditor() {
  if (!state.profile) return;
  els.manualProfileEditor.innerHTML = ["x","y","z","t","c"].map(axis => {
    const meta = axisMeta(axis);
    return `<div class="manual-row"><strong style="color:${meta.color}">${meta.short}</strong><input id="manual-${axis}-number" type="number" min="-50" max="50" step="1" value="${state.profile[axis]}"><input id="manual-${axis}-range" type="range" min="-50" max="50" step="1" value="${state.profile[axis]}"></div>`;
  }).join("");
  ["x","y","z","t","c"].forEach(axis => {
    const number = document.getElementById(`manual-${axis}-number`);
    const range = document.getElementById(`manual-${axis}-range`);
    number.addEventListener("input", () => { number.value = clamp(number.value); range.value = number.value; });
    range.addEventListener("input", () => { number.value = range.value; });
  });
}

function miniProfileHtml(profile, label) {
  return `<div class="profile-dot" style="color:${profile.color};background:${profile.color}"></div><div><strong>${escapeHtml(label)}</strong><span>${[profile.x,profile.y,profile.z,profile.t,profile.c].map(v => v>0?`+${format(v,0)}`:format(v,0)).join(" · ")}</span></div>`;
}

function calculatePairAnalysis(a, b) {
  const da = derive(a), db = derive(b);
  const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y), dz = Math.abs(a.z - b.z);
  const distance = Math.hypot(dx, dy, dz);
  const maxDistance = Math.sqrt(3 * 100 ** 2);
  const sx = clamp01(1 - Math.abs(dx - 20) / 80);
  const sy = clamp01(1 - Math.abs(dy - 20) / 80);
  const sz = clamp01(1 - dz / 100);
  const basis = (sx + sy + sz) / 3;
  const flex = clamp01((da.outer + db.outer) / 200);
  const auth = clamp01(((a.c + 50) * (b.c + 50)) / 10000);
  const compatibility = clamp01(basis * flex * auth);
  const fullCoverage = distance === 0 ? 1 : Math.min(1, (da.outer + db.outer) / distance);
  const safeCoverage = distance === 0 ? 1 : Math.min(1, (da.inner + db.inner) / distance);
  const riskDependency = fullCoverage < 1 ? 1 : clamp01((distance - (da.inner + db.inner)) / Math.max(distance, 1));
  const distanceLoad = distance / maxDistance;
  const rigidityLoad = 1 - flex;
  const authLoad = 1 - auth;
  const extremityA = Math.hypot(a.x,a.y,a.z) / Math.sqrt(3*50**2);
  const extremityB = Math.hypot(b.x,b.y,b.z) / Math.sqrt(3*50**2);
  const similarity3d = 1 - distanceLoad;
  const resonanceLoad = clamp01(similarity3d * ((extremityA + extremityB) / 2));
  let difficulty = 100 * (0.30*distanceLoad + 0.25*riskDependency + 0.15*rigidityLoad + 0.20*authLoad + 0.10*resonanceLoad);
  let level = difficulty < 25 ? "EASY" : difficulty < 45 ? "MEDIUM" : difficulty < 65 ? "HARD" : difficulty < 82 ? "EXPERT" : "NIGHTMARE";
  if (flex > .72 && auth < .18) { level = "NIGHTMARE"; difficulty = Math.max(difficulty, 86); }
  else if (distanceLoad > .72 && flex > .72 && auth > .62) { level = "HARD"; difficulty = Math.max(difficulty, 57); }
  else if (resonanceLoad > .68 && flex > .65 && auth > .60) { level = "EXPERT"; difficulty = Math.max(difficulty, 70); }

  const diagnostics = [];
  if (basis > .72 && (flex < .35 || auth < .28)) diagnostics.push([tr("diagImaginaryTitle"), tr("diagImaginaryText")]);
  if (flex > .65 && auth < .35) diagnostics.push([tr("diagCreditTitle"), tr("diagCreditText")]);
  if (Math.min((a.t+50)/100,(b.t+50)/100, (a.c+50)/100,(b.c+50)/100) < .18) diagnostics.push([tr("diagFragileTitle"), tr("diagFragileText")]);
  if (basis >= .65 && auth >= .50 && flex < .40) diagnostics.push([tr("diagInertiaTitle"), tr("diagInertiaText")]);
  if (distance >= 25 && distance <= 60 && basis >= .65 && safeCoverage >= 1) diagnostics.push([tr("diagDiversityTitle"), tr("diagDiversityText")]);
  if (safeCoverage >= 1) diagnostics.push([tr("diagSafeTitle"), tr("diagSafeText")]);
  else if (fullCoverage < 1) diagnostics.push([tr("diagUnreachableTitle"), tr("diagUnreachableText")]);
  else diagnostics.push([tr("diagRiskTitle"), tr("diagRiskText")]);
  if (resonanceLoad > .65) diagnostics.push([tr("diagResonanceTitle"), tr("diagResonanceText")]);

  return { dx,dy,dz,distance,basis,flex,auth,compatibility,fullCoverage,safeCoverage,riskDependency,difficulty,level,diagnostics };
}

function renderComparison() {
  if (!state.profile || !state.partner) {
    els.comparisonResults.classList.remove("active");
    return;
  }
  const analysis = calculatePairAnalysis(state.profile, state.partner);
  els.comparisonResults.classList.add("active");
  compareScene?.setProfiles([{...state.profile,name:tr("you")},{...state.partner,name:tr("partner")}], true);
  els.partnerScales.innerHTML = ["x","y","z","t","c"].map(axis => createScale(axis, state.partner[axis], {color:state.partner.color})).join("");
  els.partnerSummary.innerHTML = ["x","y","z","t","c"].map(axis => { const s=axisSummary(axis,state.partner[axis]); return `<div class="summary-block"><strong>${escapeHtml(s.title)}</strong><p>${escapeHtml(s.text)}</p></div>`; }).join("");
  els.analysisMetrics.innerHTML = [
    [tr("metricCompatibility"), `${format(analysis.compatibility*100)}%`, "primary"],
    [tr("metricBasis"), `${format(analysis.basis*100)}%`, ""],
    [tr("metricFlex"), `${format(analysis.flex*100)}%`, ""],
    [tr("metricAuth"), `${format(analysis.auth*100)}%`, ""],
    [tr("metricSafeCoverage"), `${format(analysis.safeCoverage*100)}%`, "good"],
    [tr("metricRisk"), `${format(analysis.riskDependency*100)}%`, "warn"],
    [tr("metricDistance"), format(analysis.distance), ""],
    [tr("metricFullCoverage"), `${format(analysis.fullCoverage*100)}%`, ""]
  ].map(([label,value,cls]) => `<div class="analysis-metric ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`).join("");
  els.difficultyValue.textContent = `${format(analysis.difficulty)} / 100`;
  els.difficultyBadge.textContent = analysis.level;
  els.difficultyBadge.className = `difficulty-badge ${analysis.level.toLowerCase()}`;
  els.diagnosticsList.innerHTML = analysis.diagnostics.map(([title,text]) => `<div class="diagnostic-item"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>`).join("");
}



let profileScene = null;
let compareScene = null;

function initScenes() {
  profileScene = new ProfileScene(els.profileScene, axisMeta);
  compareScene = new ProfileScene(els.compareScene, axisMeta);
  if (state.profile) renderProfileView();
  if (state.profile && state.partner) renderComparison();
}

async function startQrScanner() {
  if (!window.Html5Qrcode) { els.partnerImportStatus.textContent=tr("scannerLoadFailed"); return; }
  if (state.scannerRunning) return;
  els.scannerShell.classList.add("active");
  state.scanner = state.scanner || new window.Html5Qrcode("qrReader");
  try {
    await state.scanner.start({facingMode:"environment"},{fps:10,qrbox:{width:220,height:220}},decoded=>{
      applyPartnerRaw(decoded);
      stopQrScanner();
    },()=>{});
    state.scannerRunning=true;
  } catch (error) {
    els.partnerImportStatus.textContent=tr("cameraFailed", {error});
    els.scannerShell.classList.remove("active");
  }
}

async function stopQrScanner() {
  if (state.scanner && state.scannerRunning) {
    try { await state.scanner.stop(); } catch {}
  }
  state.scannerRunning=false;
  els.scannerShell.classList.remove("active");
}

async function scanQrFile(file) {
  if (!file || !window.Html5Qrcode) return;
  state.scanner = state.scanner || new window.Html5Qrcode("qrReader");
  try { const decoded=await state.scanner.scanFile(file,true); applyPartnerRaw(decoded); }
  catch(error){ els.partnerImportStatus.textContent=tr("qrNotRecognized", {error}); }
  finally { els.qrFileInput.value=""; }
}

function applyPartnerRaw(raw) {
  try {
    const profile=parseProfileCode(raw);
    state.partner=profile;
    saveJson(STORAGE.partner,state.partner);
    els.partnerCodeInput.value=profileCode(profile);
    els.partnerImportStatus.textContent=tr("profileAccepted", {code:profileCode(profile)});
    renderComparison();
  } catch(error) {
    els.partnerImportStatus.textContent=tr("error", {error:error.message});
  }
}

document.querySelectorAll("[data-view-target]").forEach(button=>button.addEventListener("click",()=>showView(button.dataset.viewTarget)));
els.prevQuestionBtn.addEventListener("click",()=>{ if(state.currentQuestion>0){state.currentQuestion-=1;renderQuestion();} });
els.nextQuestionBtn.addEventListener("click",()=>{ if(!answerIsSet(state.currentQuestion))return; if(state.currentQuestion<TEST_QUESTIONS.length-1){state.currentQuestion+=1;renderQuestion();}else finishTest(); });
els.demoAnswersBtn.addEventListener("click",()=>{ TEST_QUESTIONS.forEach((question,i)=>{ state.answers[i] = i % 13 === 0 ? "na" : ((i + (question.reverse ? 1 : 0)) % 3 === 0 ? "no" : "yes"); }); saveJson(STORAGE.answers,state.answers); state.currentQuestion=0; renderQuestion(); });
els.resetTestBtn.addEventListener("click",()=>{ state.answers={}; state.quality=null; state.currentQuestion=0; localStorage.removeItem(STORAGE.answers); localStorage.removeItem(STORAGE.quality); renderQuestion(); });
els.retakeTestBtn.addEventListener("click",()=>{ state.currentQuestion=0; showView("test"); renderQuestion(); });
els.goCompareBtn.addEventListener("click",()=>showView("compare"));
els.copyProfileCodeBtn.addEventListener("click",async()=>{ try{await navigator.clipboard.writeText(els.myProfileCode.value); els.copyProfileCodeBtn.textContent=tr("copied"); setTimeout(()=>els.copyProfileCodeBtn.textContent=tr("copyCode"),1200);}catch{els.myProfileCode.select();document.execCommand("copy");} });
els.saveManualProfileBtn.addEventListener("click",()=>{ if(!state.profile)return; ["x","y","z","t","c"].forEach(axis=>{state.profile[axis]=clamp(document.getElementById(`manual-${axis}-number`).value);}); saveJson(STORAGE.profile,state.profile); renderProfileView(); renderComparison(); });
els.restoreTestProfileBtn.addEventListener("click",()=>{ if(!state.testProfile)return; state.profile={...state.testProfile}; saveJson(STORAGE.profile,state.profile); renderProfileView(); renderComparison(); });
els.applyPartnerCodeBtn.addEventListener("click",()=>applyPartnerRaw(els.partnerCodeInput.value));
els.startQrScannerBtn.addEventListener("click",startQrScanner);
els.stopQrScannerBtn.addEventListener("click",stopQrScanner);
els.uploadQrBtn.addEventListener("click",()=>els.qrFileInput.click());
els.qrFileInput.addEventListener("change",()=>scanQrFile(els.qrFileInput.files[0]));
document.querySelectorAll(".profile-view-btn").forEach(button=>button.addEventListener("click",()=>profileScene?.setView(button.dataset.sceneView)));
document.querySelectorAll(".compare-view-btn").forEach(button=>button.addEventListener("click",()=>compareScene?.setView(button.dataset.sceneView)));

els.langRuBtn.addEventListener("click",()=>{ state.lang="ru"; localStorage.setItem(STORAGE.language,state.lang); applyLanguage(); });
els.langEnBtn.addEventListener("click",()=>{ state.lang="en"; localStorage.setItem(STORAGE.language,state.lang); applyLanguage(); });

els.questionCountBadge.textContent=tr("questionCount", {count:TEST_QUESTIONS.length});
applyLanguage();
updateProfileAvailability();
initScenes();

if (state.profile) {
  showView("profile");
  renderProfileView();
  if (state.partner) { els.partnerCodeInput.value=profileCode(state.partner); els.partnerImportStatus.textContent=tr("savedProfile", {code:profileCode(state.partner)}); renderComparison(); }
} else {
  showView("test");
}

(() => {
  // ---- Storage helpers ----
  const LS_KEY = "wt_v1";
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  function loadState() {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      const fresh = { exercises: [], workouts: [], draftId: null };
      localStorage.setItem(LS_KEY, JSON.stringify(fresh));
      return fresh;
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        exercises: Array.isArray(parsed.exercises) ? parsed.exercises : [],
        workouts: Array.isArray(parsed.workouts) ? parsed.workouts : [],
        draftId: typeof parsed.draftId === "string" ? parsed.draftId : null,
      };
    } catch {
      const fresh = { exercises: [], workouts: [], draftId: null };
      localStorage.setItem(LS_KEY, JSON.stringify(fresh));
      return fresh;
    }
  }

  function saveState(state) {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  function todayLocalISODate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function formatDate(iso) {
    // iso is YYYY-MM-DD
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  // ---- Workout logic ----
  function getOrCreateTodayDraft(state) {
    const today = todayLocalISODate();

    // Try resume draftId
    if (state.draftId) {
      const found = state.workouts.find(w => w.id === state.draftId && w.status === "draft");
      if (found && found.date === today) return found;
    }

    // Try find any draft for today
    const existing = state.workouts.find(w => w.status === "draft" && w.date === today);
    if (existing) {
      state.draftId = existing.id;
      saveState(state);
      return existing;
    }

    // Create new
    const workout = {
      id: uid(),
      date: today,
      status: "draft",
      createdAt: Date.now(),
      exercises: [], // { name, sets:[{reps,weight}], completedAt }
    };
    state.workouts.push(workout);
    state.draftId = workout.id;
    saveState(state);
    return workout;
  }

  function completeDraftWorkout(state, workoutId) {
    const w = state.workouts.find(x => x.id === workoutId);
    if (!w) return;
    w.status = "completed";
    w.completedAt = Date.now();
    state.draftId = null;
    saveState(state);
  }

  function addExerciseToLibrary(state, name) {
    const clean = name.trim();
    if (!clean) return;
    const exists = state.exercises.some(x => x.toLowerCase() === clean.toLowerCase());
    if (!exists) {
      state.exercises.push(clean);
      state.exercises.sort((a, b) => a.localeCompare(b));
      saveState(state);
    }
  }

  function findLastTimeForExercise(state, exerciseName, excludeWorkoutId) {
    const target = exerciseName.trim().toLowerCase();
    const completed = state.workouts
      .filter(w => w.status === "completed" && w.id !== excludeWorkoutId)
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    for (const w of completed) {
      const ex = (w.exercises || []).slice().reverse().find(e => (e.name || "").trim().toLowerCase() === target);
      if (ex) return { workout: w, exercise: ex };
    }
    return null;
  }

  // ---- Simple router ----
  const app = document.getElementById("app");

  function nav(hash) {
    location.hash = hash;
  }

  function getRoute() {
    const h = (location.hash || "#home").slice(1);
    const parts = h.split("/").filter(Boolean);
    return { name: parts[0] || "home", parts };
  }

  window.addEventListener("hashchange", render);
  render();

  // ---- Views ----
  function render() {
    const state = loadState();
    const route = getRoute();

    if (route.name === "home") return renderHome(state);
    if (route.name === "workout") return renderWorkout(state);
    if (route.name === "history") return renderHistory(state);
    if (route.name === "view" && route.parts[1]) return renderWorkoutDetails(state, route.parts[1]);

    nav("#home");
  }

  function shell({ title, subtitle, leftBtn, rightBtn, body }) {
    app.innerHTML = `
      <div class="container">
        <div class="header">
          <div style="width:120px;">
            ${leftBtn || ""}
          </div>
          <div class="hgroup" style="text-align:center; flex:1;">
            <div class="title">${escapeHtml(title)}</div>
            ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}
          </div>
          <div style="width:120px; display:flex; justify-content:flex-end;">
            ${rightBtn || ""}
          </div>
        </div>
        ${body}
      </div>
    `;
  }

  function renderHome(state) {
    shell({
      title: "Workout Tracker",
      subtitle: "Quick logging. Saved on this device.",
      leftBtn: "",
      rightBtn: "",
      body: `
        <div class="card">
          <div class="grid2">
            <button class="btn primary" id="goStart">
              <div style="font-size:16px; font-weight:800;">Start Workout</div>
              <div class="small">Log today’s workout</div>
            </button>
            <button class="btn" id="goHistory">
              <div style="font-size:16px; font-weight:800;">History</div>
              <div class="small">View past workouts</div>
            </button>
          </div>
        </div>

        <div class="notice">
          Data is stored in <kbd>localStorage</kbd>. Clearing browser data will remove it.
        </div>
      `,
    });

    document.getElementById("goStart").onclick = () => nav("#workout");
    document.getElementById("goHistory").onclick = () => nav("#history");
  }

  function renderWorkout(state) {
    const workout = getOrCreateTodayDraft(state);

    // Draft exercise editor state (in-memory)
    let currentExercise = null; // { name, sets:[{reps,weight}] }
    let showLastTime = false;
    let lastTimeData = null;

    function rerender() {
      const suggestions = state.exercises.map(x => `<option value="${escapeAttr(x)}"></option>`).join("");
      const completed = (workout.exercises || []).map((ex, idx) => {
        const sets = (ex.sets || []).map((s, i) => `Set ${i + 1}: ${s.reps} reps @ ${s.weight}`).join(" • ");
        return `
          <div class="item">
            <h4>${escapeHtml(ex.name)}</h4>
            <div class="meta">${escapeHtml(sets || "No sets")}</div>
          </div>
        `;
      }).join("");

      const setsRows = (currentExercise?.sets || []).map((s, i) => `
        <tr>
          <td style="width:70px;">${i + 1}</td>
          <td><input inputmode="numeric" placeholder="Reps" data-set-reps="${i}" value="${escapeAttr(s.reps ?? "")}"></td>
          <td><input inputmode="decimal" placeholder="Weight" data-set-weight="${i}" value="${escapeAttr(s.weight ?? "")}"></td>
          <td style="width:84px;">
            <button class="btn danger" data-remove-set="${i}" style="padding:10px; text-align:center;">Remove</button>
          </td>
        </tr>
      `).join("");

      const lastTimeBlock = lastTimeData ? `
        <div class="card" style="margin-top:10px;">
          <div class="row" style="align-items:flex-start;">
            <div style="flex:1;">
              <div style="font-weight:800;">Most Recent</div>
              <div class="small">${escapeHtml(formatDate(lastTimeData.workout.date))}</div>
            </div>
            <button class="btn" id="hideLast" style="max-width:120px; padding:10px; text-align:center;">Close</button>
          </div>
          <div class="hr"></div>
          <div class="small" style="line-height:1.6;">
            ${escapeHtml(renderSetsLine(lastTimeData.exercise.sets))}
          </div>
        </div>
      ` : "";

      shell({
        title: "Start Workout",
        subtitle: formatDate(workout.date),
        leftBtn: `<button class="btn" id="backHome" style="padding:10px; text-align:center;">Home</button>`,
        rightBtn: `<button class="btn ok" id="finishWorkout" style="padding:10px; text-align:center;">Finish</button>`,
        body: `
          <div class="card">
            <div class="label">Add Exercise</div>
            <div class="row wrap">
              <div style="flex:2;">
                <input id="exerciseInput" list="exerciseList" placeholder="e.g., Bench Press" />
                <datalist id="exerciseList">${suggestions}</datalist>
              </div>
              <div style="flex:1;">
                <button class="btn primary" id="startExercise" style="text-align:center;">Start</button>
              </div>
            </div>

            ${currentExercise ? `
              <div class="hr"></div>

              <div class="row">
                <div>
                  <div class="label">Current Exercise</div>
                  <div style="font-weight:800; font-size:16px;">${escapeHtml(currentExercise.name)}</div>
                  <div class="small">Add sets, then complete this exercise.</div>
                </div>
                <div style="max-width:160px;">
                  <button class="btn" id="lastTimeBtn" style="text-align:center;" ${canShowLastTime(state, currentExercise.name, workout.id) ? "" : "disabled"}>Last time</button>
                </div>
              </div>

              ${lastTimeBlock}

              <div class="hr"></div>

              <div class="label">Sets</div>
              <table class="table">
                <thead>
                  <tr>
                    <th style="width:70px;">Set</th>
                    <th>Reps</th>
                    <th>Weight</th>
                    <th style="width:84px;"></th>
                  </tr>
                </thead>
                <tbody>
                  ${setsRows || `<tr><td colspan="4" class="small">No sets yet. Tap “Add set”.</td></tr>`}
                </tbody>
              </table>

              <div class="row" style="margin-top:10px;">
                <button class="btn" id="addSet" style="text-align:center;">Add set</button>
                <button class="btn ok" id="completeExercise" style="text-align:center;">Complete Exercise</button>
              </div>
            ` : `
              <div class="hr"></div>
              <div class="small">Tip: start typing to see exercises you’ve used before.</div>
            `}
          </div>

          <div class="card">
            <div class="row">
              <div>
                <div style="font-weight:800;">Completed in this workout</div>
                <div class="small">${(workout.exercises || []).length} exercise(s)</div>
              </div>
              <div style="max-width:160px;">
                <button class="btn danger" id="discardDraft" style="text-align:center;">Discard</button>
              </div>
            </div>
            <div class="hr"></div>
            <div class="list">
              ${completed || `<div class="small">Nothing completed yet.</div>`}
            </div>
          </div>
        `,
      });

      // Wire header buttons
      document.getElementById("backHome").onclick = () => nav("#home");
      document.getElementById("finishWorkout").onclick = () => {
        const st = loadState();
        completeDraftWorkout(st, workout.id);
        nav(`#view/${workout.id}`);
      };

      document.getElementById("discardDraft").onclick = () => {
        const st = loadState();
        // remove the draft workout entirely
        st.workouts = st.workouts.filter(w => w.id !== workout.id);
        if (st.draftId === workout.id) st.draftId = null;
        saveState(st);
        nav("#home");
      };

      // Start Exercise
      const startBtn = document.getElementById("startExercise");
      const input = document.getElementById("exerciseInput");
      startBtn.onclick = () => {
        const name = (input.value || "").trim();
        if (!name) return;
        addExerciseToLibrary(loadState(), name); // add & persist
        // refresh state in-memory too
        state = loadState();

        currentExercise = { name, sets: [{ reps: "", weight: "" }] };
        lastTimeData = null;
        input.value = "";
        rerender();
      };

      // If editing sets
      if (currentExercise) {
        // Add set
        document.getElementById("addSet").onclick = () => {
          currentExercise.sets.push({ reps: "", weight: "" });
          rerender();
        };

        // Remove set
        app.querySelectorAll("[data-remove-set]").forEach(btn => {
          btn.onclick = () => {
            const i = Number(btn.getAttribute("data-remove-set"));
            currentExercise.sets.splice(i, 1);
            if (currentExercise.sets.length === 0) currentExercise.sets.push({ reps: "", weight: "" });
            rerender();
          };
        });

        // Update inputs
        app.querySelectorAll("input[data-set-reps]").forEach(el => {
          el.addEventListener("input", () => {
            const i = Number(el.getAttribute("data-set-reps"));
            currentExercise.sets[i].reps = el.value;
          });
        });
        app.querySelectorAll("input[data-set-weight]").forEach(el => {
          el.addEventListener("input", () => {
            const i = Number(el.getAttribute("data-set-weight"));
            currentExercise.sets[i].weight = el.value;
          });
        });

        // Last time button
        const lastBtn = document.getElementById("lastTimeBtn");
        lastBtn.onclick = () => {
          const st = loadState();
          lastTimeData = findLastTimeForExercise(st, currentExercise.name, workout.id);
          rerender();
        };

        if (lastTimeData) {
          document.getElementById("hideLast").onclick = () => {
            lastTimeData = null;
            rerender();
          };
        }

        // Complete exercise
        document.getElementById("completeExercise").onclick = () => {
          // validate
          const cleanedSets = currentExercise.sets
            .map(s => ({ reps: toNumberOrNull(s.reps), weight: toNumberOrNull(s.weight) }))
            .filter(s => s.reps !== null || s.weight !== null);

          // If user left blanks, still allow but prefer at least one set
          if (cleanedSets.length === 0) {
            currentExercise.sets = [{ reps: "", weight: "" }];
            rerender();
            return;
          }

          // Enforce non-negative
          for (const s of cleanedSets) {
            if (s.reps !== null && s.reps < 0) return;
            if (s.weight !== null && s.weight < 0) return;
          }

          const st = loadState();
          const w = st.workouts.find(x => x.id === workout.id);
          if (!w) return;

          w.exercises = w.exercises || [];
          w.exercises.push({
            name: currentExercise.name.trim(),
            sets: cleanedSets.map(s => ({ reps: s.reps ?? 0, weight: s.weight ?? 0 })),
            completedAt: Date.now(),
          });

          saveState(st);
          // refresh local references
          state = loadState();
          const updated = state.workouts.find(x => x.id === workout.id);
          workout.exercises = updated.exercises;

          currentExercise = null;
          lastTimeData = null;
          rerender();
        };
      }
    }

    rerender();
  }

  function renderHistory(state) {
    const completed = state.workouts
      .filter(w => w.status === "completed")
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    const listHtml = completed.map(w => `
      <button class="btn item" data-open="${escapeAttr(w.id)}">
        <h4>${escapeHtml(formatDate(w.date))}</h4>
        <div class="meta">${(w.exercises || []).length} exercise(s)</div>
      </button>
    `).join("");

    shell({
      title: "History",
      subtitle: completed.length ? `${completed.length} workout(s)` : "No workouts yet",
      leftBtn: `<button class="btn" id="backHome" style="padding:10px; text-align:center;">Home</button>`,
      rightBtn: `<button class="btn danger" id="clearAll" style="padding:10px; text-align:center;">Clear</button>`,
      body: `
        <div class="card">
          <div class="list">
            ${listHtml || `<div class="small">No completed workouts yet. Go log one.</div>`}
          </div>
        </div>
      `,
    });

    document.getElementById("backHome").onclick = () => nav("#home");

    document.getElementById("clearAll").onclick = () => {
      // wipe everything
      localStorage.removeItem(LS_KEY);
      nav("#home");
    };

    app.querySelectorAll("[data-open]").forEach(btn => {
      btn.onclick = () => nav(`#view/${btn.getAttribute("data-open")}`);
    });
  }

  function renderWorkoutDetails(state, id) {
    const w = state.workouts.find(x => x.id === id);
    if (!w) return nav("#history");

    const exHtml = (w.exercises || []).map(ex => {
      const rows = (ex.sets || []).map((s, i) => `
        <tr>
          <td style="width:70px;">${i + 1}</td>
          <td>${escapeHtml(String(s.reps ?? ""))}</td>
          <td>${escapeHtml(String(s.weight ?? ""))}</td>
        </tr>
      `).join("");

      return `
        <div class="item">
          <h4>${escapeHtml(ex.name)}</h4>
          <div class="hr"></div>
          <table class="table">
            <thead>
              <tr><th style="width:70px;">Set</th><th>Reps</th><th>Weight</th></tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="3" class="small">No sets</td></tr>`}
            </tbody>
          </table>
        </div>
      `;
    }).join("");

    shell({
      title: "Workout Details",
      subtitle: formatDate(w.date),
      leftBtn: `<button class="btn" id="backHistory" style="padding:10px; text-align:center;">History</button>`,
      rightBtn: `<button class="btn danger" id="deleteWorkout" style="padding:10px; text-align:center;">Delete</button>`,
      body: `
        <div class="card">
          <div class="row">
            <div class="pill">${escapeHtml(w.status === "completed" ? "Completed" : "Draft")}</div>
            <div class="pill">${(w.exercises || []).length} exercise(s)</div>
          </div>
          <div class="hr"></div>
          <div class="list">
            ${exHtml || `<div class="small">No exercises in this workout.</div>`}
          </div>
        </div>
      `,
    });

    document.getElementById("backHistory").onclick = () => nav("#history");

    document.getElementById("deleteWorkout").onclick = () => {
      const st = loadState();
      st.workouts = st.workouts.filter(x => x.id !== id);
      if (st.draftId === id) st.draftId = null;
      saveState(st);
      nav("#history");
    };
  }

  // ---- Helpers ----
  function canShowLastTime(state, exerciseName, currentWorkoutId) {
    return !!findLastTimeForExercise(state, exerciseName, currentWorkoutId);
  }

  function renderSetsLine(sets) {
    if (!Array.isArray(sets) || sets.length === 0) return "No sets";
    return sets.map((s, i) => `Set ${i + 1}: ${s.reps} reps @ ${s.weight}`).join(" • ");
  }

  function toNumberOrNull(v) {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
    }[m]));
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;");
  }
})();

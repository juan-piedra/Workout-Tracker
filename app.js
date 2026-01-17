(() => {
  // ====== CONFIG (fill these in) ======
  const SUPABASE_URL = "https://jznbofjdpawonjajbpcc.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6bmJvZmpkcGF3b25qYWpicGNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg2ODM5NjUsImV4cCI6MjA4NDI1OTk2NX0.IinYTuCmJApablKk7O6oJKJ9rDKagG3ZsDIisrWzxxI";

  // If you truly want *no* auth tokens stored in localStorage,
  // set persistSession=false (you'll need to log in again on refresh).
  // Supabase supports client options like persistSession. (See docs examples.) 
  // const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

  // ====== Supabase client ======
  if (!window.supabase || !window.supabase.createClient) {
    document.body.innerHTML =
      "<div style='padding:16px;font-family:system-ui'>Supabase JS not loaded. Check index.html script order.</div>";
    return;
  }
  const { createClient } = window.supabase;
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ====== App state (stored remotely in public.app_state.state jsonb) ======
  const app = document.getElementById("app");
  let currentUser = null;
  let stateCache = null;
  let saveTimer = null;

  const freshState = () => ({ exercises: [], workouts: [], draftId: null });

  function todayLocalISODate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[m]));
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;");
  }

  function getRoute() {
    const h = (location.hash || "#home").slice(1);
    const parts = h.split("/").filter(Boolean);
    return { name: parts[0] || "home", parts };
  }
  function nav(hash) {
    location.hash = hash;
  }

  // ====== Remote load/save ======
  async function ensureUser() {
    const { data } = await sb.auth.getSession();
    currentUser = data?.session?.user || null;
    return currentUser;
  }

  async function loadRemoteState(userId) {
    const { data, error } = await sb
      .from("app_state")
      .select("state")
      .eq("user_id", userId);

    if (error) throw error;

    if (!data || data.length === 0) {
      const initial = freshState();
      const ins = await sb.from("app_state").insert({ user_id: userId, state: initial });
      if (ins.error) throw ins.error;
      return initial;
    }

    const s = data[0]?.state;
    return (s && typeof s === "object") ? s : freshState();
  }

  async function saveRemoteStateNow() {
    if (!currentUser || !stateCache) return;
    const payload = { user_id: currentUser.id, state: stateCache };

    const { error } = await sb.from("app_state").upsert(payload);
    if (error) {
      console.error("Save failed:", error.message);
    }
  }

  function queueSave(ms = 600) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveRemoteStateNow();
    }, ms);
  }

  // ====== Workout logic (same structure as before) ======
  function normalizeWorkout(w) {
    if (!w) return w;
    if (typeof w.name !== "string") w.name = "";
    if (!Array.isArray(w.exercises)) w.exercises = [];
    return w;
  }

  function getOrCreateTodayDraft() {
    const today = todayLocalISODate();
    const st = stateCache;

    if (st.draftId) {
      const found = st.workouts.find((w) => w.id === st.draftId && w.status === "draft");
      if (found && found.date === today) return normalizeWorkout(found);
    }

    const existing = st.workouts.find((w) => w.status === "draft" && w.date === today);
    if (existing) {
      st.draftId = existing.id;
      queueSave();
      return normalizeWorkout(existing);
    }

    const workout = {
      id: uid(),
      date: today,
      name: "",
      status: "draft",
      createdAt: Date.now(),
      exercises: [],
    };
    st.workouts.push(workout);
    st.draftId = workout.id;
    queueSave();
    return normalizeWorkout(workout);
  }

  function addExerciseToLibrary(name) {
    const clean = name.trim();
    if (!clean) return;
    const exists = stateCache.exercises.some((x) => x.toLowerCase() === clean.toLowerCase());
    if (!exists) {
      stateCache.exercises.push(clean);
      stateCache.exercises.sort((a, b) => a.localeCompare(b));
      queueSave();
    }
  }

  function findLastTimeForExercise(exerciseName, excludeWorkoutId) {
    const target = exerciseName.trim().toLowerCase();
    const completed = stateCache.workouts
      .filter((w) => w.status === "completed" && w.id !== excludeWorkoutId)
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    for (const w of completed) {
      const ex = (w.exercises || []).slice().reverse().find((e) => (e.name || "").trim().toLowerCase() === target);
      if (ex) return { workout: w, exercise: ex };
    }
    return null;
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

  // ====== UI shell ======
  function shell({ title, subtitle, leftBtn, rightBtn, body }) {
    app.innerHTML = `
      <div class="container">
        <div class="header">
          <div style="width:120px;">${leftBtn || ""}</div>
          <div class="hgroup" style="text-align:center; flex:1;">
            <div class="title">${escapeHtml(title)}</div>
            ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}
          </div>
          <div style="width:120px; display:flex; justify-content:flex-end;">${rightBtn || ""}</div>
        </div>
        ${body}
      </div>
    `;
  }

  // ====== Auth UI ======
  function renderAuth() {
    shell({
      title: "Workout Tracker",
      subtitle: "Sign in to sync workouts",
      leftBtn: "",
      rightBtn: "",
      body: `
        <div class="card">
          <div class="label">Email</div>
          <input id="email" type="email" placeholder="you@example.com" />
          <div class="hr"></div>
          <div class="label">Password</div>
          <input id="password" type="password" placeholder="••••••••" />
          <div class="hr"></div>
          <div class="row">
            <button class="btn primary" id="signIn" style="text-align:center;">Sign in</button>
            <button class="btn" id="signUp" style="text-align:center;">Sign up</button>
          </div>
          <div class="small" id="authMsg" style="margin-top:10px;"></div>
        </div>
      `,
    });

    const msg = document.getElementById("authMsg");
    const getCreds = () => ({
      email: (document.getElementById("email").value || "").trim(),
      password: (document.getElementById("password").value || "").trim(),
    });

    document.getElementById("signIn").onclick = async () => {
      const { email, password } = getCreds();
      msg.textContent = "Signing in...";
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) msg.textContent = error.message;
      else msg.textContent = "";
      await boot();
    };

    document.getElementById("signUp").onclick = async () => {
      const { email, password } = getCreds();
      msg.textContent = "Creating account...";
      const { error, data } = await sb.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.href },
      });
      if (error) {
        msg.textContent = error.message;
        return;
      }
      // If email confirmation is enabled, session may be null until confirmed.
      msg.textContent = data?.session ? "Signed up and logged in!" : "Check your email to confirm your account.";
      await boot();
    };
  }

  // ====== Views ======
  function renderHome() {
    shell({
      title: "Workout Tracker",
      subtitle: "Synced with Supabase",
      leftBtn: "",
      rightBtn: `<button class="btn" id="signOut" style="padding:10px; text-align:center;">Sign out</button>`,
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
      `,
    });

    document.getElementById("goStart").onclick = () => nav("#workout");
    document.getElementById("goHistory").onclick = () => nav("#history");
    document.getElementById("signOut").onclick = async () => {
      await sb.auth.signOut();
      currentUser = null;
      stateCache = null;
      nav("#home");
      render();
    };
  }

  function renderWorkout() {
    const workout = getOrCreateTodayDraft();

    let currentExercise = null; // { name, sets:[{reps,weight}] }
    let lastTimeData = null;

    const rerender = () => {
      const suggestions = stateCache.exercises.map((x) => `<option value="${escapeAttr(x)}"></option>`).join("");

      const completed = (workout.exercises || []).map((ex) => {
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

      const canShowLast = !!(currentExercise && findLastTimeForExercise(currentExercise.name, workout.id));

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
        title: workout.name ? workout.name : "Start Workout",
        subtitle: formatDate(workout.date),
        leftBtn: `<button class="btn" id="backHome" style="padding:10px; text-align:center;">Home</button>`,
        rightBtn: `<button class="btn ok" id="finishWorkout" style="padding:10px; text-align:center;">Finish</button>`,
        body: `
          <div class="card">
            <div class="label">Workout name (optional)</div>
            <input id="workoutName" placeholder="e.g., Push Day" value="${escapeAttr(workout.name || "")}" />
            <div class="small" style="margin-top:6px;">Date stays saved: ${escapeHtml(formatDate(workout.date))}</div>

            <div class="hr"></div>

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
                  <button class="btn" id="lastTimeBtn" style="text-align:center;" ${canShowLast ? "" : "disabled"}>Last time</button>
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

      document.getElementById("backHome").onclick = () => nav("#home");

      document.getElementById("workoutName").oninput = (e) => {
        workout.name = e.target.value.trim();
        queueSave();
      };

      document.getElementById("finishWorkout").onclick = async () => {
        workout.status = "completed";
        workout.completedAt = Date.now();
        stateCache.draftId = null;
        await saveRemoteStateNow();
        nav(`#view/${workout.id}`);
      };

      document.getElementById("discardDraft").onclick = async () => {
        stateCache.workouts = stateCache.workouts.filter((w) => w.id !== workout.id);
        if (stateCache.draftId === workout.id) stateCache.draftId = null;
        await saveRemoteStateNow();
        nav("#home");
      };

      document.getElementById("startExercise").onclick = () => {
        const input = document.getElementById("exerciseInput");
        const name = (input.value || "").trim();
        if (!name) return;
        addExerciseToLibrary(name);
        currentExercise = { name, sets: [{ reps: "", weight: "" }] };
        lastTimeData = null;
        input.value = "";
        rerender();
      };

      if (currentExercise) {
        document.getElementById("addSet").onclick = () => {
          currentExercise.sets.push({ reps: "", weight: "" });
          rerender();
        };

        app.querySelectorAll("[data-remove-set]").forEach((btn) => {
          btn.onclick = () => {
            const i = Number(btn.getAttribute("data-remove-set"));
            currentExercise.sets.splice(i, 1);
            if (currentExercise.sets.length === 0) currentExercise.sets.push({ reps: "", weight: "" });
            rerender();
          };
        });

        app.querySelectorAll("input[data-set-reps]").forEach((el) => {
          el.addEventListener("input", () => {
            const i = Number(el.getAttribute("data-set-reps"));
            currentExercise.sets[i].reps = el.value;
          });
        });
        app.querySelectorAll("input[data-set-weight]").forEach((el) => {
          el.addEventListener("input", () => {
            const i = Number(el.getAttribute("data-set-weight"));
            currentExercise.sets[i].weight = el.value;
          });
        });

        const lastBtn = document.getElementById("lastTimeBtn");
        lastBtn.onclick = () => {
          lastTimeData = findLastTimeForExercise(currentExercise.name, workout.id);
          rerender();
        };

        if (lastTimeData) {
          document.getElementById("hideLast").onclick = () => {
            lastTimeData = null;
            rerender();
          };
        }

        document.getElementById("completeExercise").onclick = () => {
          const cleanedSets = currentExercise.sets
            .map((s) => ({ reps: toNumberOrNull(s.reps), weight: toNumberOrNull(s.weight) }))
            .filter((s) => s.reps !== null || s.weight !== null);

          if (cleanedSets.length === 0) return;

          for (const s of cleanedSets) {
            if (s.reps !== null && s.reps < 0) return;
            if (s.weight !== null && s.weight < 0) return;
          }

          workout.exercises = workout.exercises || [];
          workout.exercises.push({
            name: currentExercise.name.trim(),
            sets: cleanedSets.map((s) => ({ reps: s.reps ?? 0, weight: s.weight ?? 0 })),
            completedAt: Date.now(),
          });

          queueSave();

          currentExercise = null;
          lastTimeData = null;
          rerender();
        };
      }
    };

    rerender();
  }

  function renderHistory() {
    const completed = stateCache.workouts
      .filter((w) => w.status === "completed")
      .map(normalizeWorkout)
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    const listHtml = completed.map((w) => {
      const title = w.name ? w.name : formatDate(w.date);
      const metaParts = [];
      if (w.name) metaParts.push(formatDate(w.date));
      metaParts.push(`${(w.exercises || []).length} exercise(s)`);
      return `
        <button class="btn item" data-open="${escapeAttr(w.id)}">
          <h4>${escapeHtml(title)}</h4>
          <div class="meta">${escapeHtml(metaParts.join(" • "))}</div>
        </button>
      `;
    }).join("");

    shell({
      title: "History",
      subtitle: completed.length ? `${completed.length} workout(s)` : "No workouts yet",
      leftBtn: `<button class="btn" id="backHome" style="padding:10px; text-align:center;">Home</button>`,
      rightBtn: "",
      body: `
        <div class="card">
          <div class="list">
            ${listHtml || `<div class="small">No completed workouts yet. Go log one.</div>`}
          </div>
        </div>
      `,
    });

    document.getElementById("backHome").onclick = () => nav("#home");
    app.querySelectorAll("[data-open]").forEach((btn) => {
      btn.onclick = () => nav(`#view/${btn.getAttribute("data-open")}`);
    });
  }

  function renderWorkoutDetails(id) {
    const w = normalizeWorkout(stateCache.workouts.find((x) => x.id === id));
    if (!w) return nav("#history");

    const exHtml = (w.exercises || []).map((ex) => {
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
      title: w.name ? w.name : "Workout Details",
      subtitle: formatDate(w.date),
      leftBtn: `<button class="btn" id="backHistory" style="padding:10px; text-align:center;">History</button>`,
      rightBtn: `<button class="btn danger" id="deleteWorkout" style="padding:10px; text-align:center;">Delete</button>`,
      body: `
        <div class="card">
          <div class="label">Workout name (optional)</div>
          <input id="detailsName" placeholder="e.g., Push Day" value="${escapeAttr(w.name || "")}" />
          <div class="small" style="margin-top:6px;">Date: ${escapeHtml(formatDate(w.date))}</div>

          <div class="hr"></div>

          <div class="list">
            ${exHtml || `<div class="small">No exercises in this workout.</div>`}
          </div>
        </div>
      `,
    });

    document.getElementById("backHistory").onclick = () => nav("#history");

    document.getElementById("detailsName").oninput = (e) => {
      w.name = e.target.value.trim();
      queueSave();
    };

    document.getElementById("deleteWorkout").onclick = async () => {
      stateCache.workouts = stateCache.workouts.filter((x) => x.id !== id);
      if (stateCache.draftId === id) stateCache.draftId = null;
      await saveRemoteStateNow();
      nav("#history");
    };
  }

  // ====== Main render ======
  async function render() {
    const user = await ensureUser();
    const route = getRoute();

    if (!user) {
      // lock app behind auth for true persistence
      if (route.name !== "home") nav("#home");
      renderAuth();
      return;
    }

    if (!stateCache) {
      shell({ title: "Loading...", subtitle: "", leftBtn: "", rightBtn: "", body: `<div class="card"><div class="small">Loading your data…</div></div>` });
      stateCache = await loadRemoteState(user.id);
    }

    if (route.name === "home") return renderHome();
    if (route.name === "workout") return renderWorkout();
    if (route.name === "history") return renderHistory();
    if (route.name === "view" && route.parts[1]) return renderWorkoutDetails(route.parts[1]);

    nav("#home");
    renderHome();
  }

  async function boot() {
    stateCache = null;
    await render();
  }

  window.addEventListener("hashchange", render);
  boot();
})();

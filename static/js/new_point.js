function handleSelects() {
	document.addEventListener('change', (e) => {
		if (e.target.matches('select')) {
			e.target.setAttribute('data-selected', e.target.value);
		}
	});
}

function handleRemoval() {
	document.addEventListener('click', (e) => {
		const removeButton = e.target.closest('.remove');
		if (!removeButton) return;

		const point = removeButton.closest('.point');
		const container = document.querySelector('#inputs');
		const currentPoints = container.querySelectorAll('.point');

		if (currentPoints.length === 1) {
			point.querySelectorAll('input, select').forEach(resetElement);
		} else {
			container.removeChild(point);
		}

		// force reflow to trigger transition
		void container.offsetHeight;
	});
}

const pointTemplate = document.createElement('template');
pointTemplate.innerHTML = document.querySelector('.point').outerHTML;

// smart point creation!
function createNewPoint() {
	const lastPoint = document.querySelector('.point:last-child');
	const clone = lastPoint?.cloneNode(true) || pointTemplate.content.cloneNode(true);

	// preserve name and select values
	clone.querySelector('.name').value = lastPoint?.querySelector('.name').value || '';
	clone.querySelectorAll('select').forEach(select => {
		const type = select.classList[0];
		const originalValue = lastPoint?.querySelector(`select.${type}`)?.value ||
			(type === 'latitude' ? 'N' : type === 'longitude' ? 'E' : 'kph');
		select.value = originalValue;
		select.setAttribute('data-selected', originalValue);
	});

	// preserve latitude/longitude numeric values from the last point
	const lastLat = lastPoint?.querySelector('input.latitude')?.value || '';
	const lastLon = lastPoint?.querySelector('input.longitude')?.value || '';
	const latInput = clone.querySelector('input.latitude');
	const lonInput = clone.querySelector('input.longitude');
	if (latInput) latInput.value = lastLat;
	if (lonInput) lonInput.value = lastLon;

	// clear other numeric inputs (e.g., speed)
	clone.querySelectorAll('input[type="number"]').forEach(input => {
		if (input.classList.contains('latitude') || input.classList.contains('longitude')) return;
		input.value = '';
	});
	return clone;
}

// data import handling
function populatePoint(data, element) {
	element.querySelector('.name').value = data.name;

	const latValue = data.latitude.replace(/[NS]$/, '');
	const latDir = data.latitude.endsWith('S') ? 'S' : 'N';
	element.querySelector('input.latitude').value = latValue;
	element.querySelector('select.latitude').value = latDir;

	const lonValue = data.longitude.replace(/[EW]$/, '');
	const lonDir = data.longitude.endsWith('W') ? 'W' : 'E';
	element.querySelector('input.longitude').value = lonValue;
	element.querySelector('select.longitude').value = lonDir;

	element.querySelector('input.speed').value = data.speed;
	element.querySelector('.stage').value = data.stage;
}

document.querySelector('#new-point').addEventListener('click', () => {
	const newPoint = createNewPoint();
	document.querySelector('#inputs').appendChild(newPoint);
	newPoint.scrollIntoView({ behavior: 'smooth' });
});

// indexedDB autosave logic
const AUTOSAVE_DB_NAME = "trackgen_autosave";
const AUTOSAVE_STORE = "manual_input";
let autosaveDB = null;

// open IndexedDB and create object store if needed
function openAutosaveDB() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(AUTOSAVE_DB_NAME, 1);
		req.onupgradeneeded = function(e) {
			const db = e.target.result;
			if (!db.objectStoreNames.contains(AUTOSAVE_STORE)) {
				db.createObjectStore(AUTOSAVE_STORE);
			}
		};
		req.onsuccess = function(e) {
			autosaveDB = e.target.result;
			resolve();
		};
		req.onerror = function(e) {
			reject(e);
		};
	});
}

function saveAutosaveData(data) {
	if (!autosaveDB) return;
	const tx = autosaveDB.transaction([AUTOSAVE_STORE], "readwrite");
	const store = tx.objectStore(AUTOSAVE_STORE);
	store.put(data, "points");
}

function loadAutosaveData() {
	return new Promise((resolve) => {
		if (!autosaveDB) return resolve(null);
		const tx = autosaveDB.transaction([AUTOSAVE_STORE], "readonly");
		const store = tx.objectStore(AUTOSAVE_STORE);
		const req = store.get("points");
		req.onsuccess = () => resolve(req.result || null);
		req.onerror = () => resolve(null);
	});
}

function clearAutosaveData() {
	if (!autosaveDB) return;
	const tx = autosaveDB.transaction([AUTOSAVE_STORE], "readwrite");
	const store = tx.objectStore(AUTOSAVE_STORE);
	store.delete("points");
}

// collect all manual input points and relevant options, plus BT file input
function collectInputData() {
	const points = [];
	document.querySelectorAll("#inputs .point").forEach(point => {
		points.push({
			name: point.querySelector(".name").value,
			latitude: point.querySelector("input.latitude").value,
			latitudeDir: point.querySelector("select.latitude").value,
			longitude: point.querySelector("input.longitude").value,
			longitudeDir: point.querySelector("select.longitude").value,
			speed: point.querySelector("input.speed").value,
			speedUnit: point.querySelector("select.speed").value,
			stage: point.querySelector(".stage").value
		});
	});
	const btTextarea = document.querySelector("#paste-upload textarea");
	const fileFormat = document.querySelector("#file-format");
	return {
		points,
		options: {
			accessible: document.getElementById("accessible")?.checked || false,
			computeAce: document.getElementById("compute-ace")?.checked || false,
			smallerDots: document.getElementById("smaller-dots")?.checked || false,
			autosave: document.getElementById("autosave")?.checked || false
		},
		bt: {
			text: btTextarea?.value || "",
			format: fileFormat?.value || ""
		}
	};
}

// restore manual input points, options, and BT file input
function restoreInputData(data) {
	if (data?.points && Array.isArray(data.points)) {
		const container = document.getElementById("inputs");
		container.innerHTML = "";
		data.points.forEach((pt) => {
			const clone = createNewPoint();
			clone.querySelector(".name").value = pt.name || "";
			clone.querySelector("input.latitude").value = pt.latitude || "";
			clone.querySelector("select.latitude").value = pt.latitudeDir || "N";
			clone.querySelector("input.longitude").value = pt.longitude || "";
			clone.querySelector("select.longitude").value = pt.longitudeDir || "E";
			clone.querySelector("input.speed").value = pt.speed || "";
			clone.querySelector("select.speed").value = pt.speedUnit || "kph";
			clone.querySelector(".stage").value = pt.stage || "Tropical cyclone";
			container.appendChild(clone);
		});
	}
	// restore options
	if (data?.options) {
		document.getElementById("accessible").checked = !!data.options.accessible;
		document.getElementById("compute-ace").checked = !!data.options.computeAce;
		document.getElementById("smaller-dots").checked = !!data.options.smallerDots;
		document.getElementById("autosave").checked = !!data.options.autosave;
	}
	// restore BT file input
	if (data?.bt) {
		const btTextarea = document.querySelector("#paste-upload textarea");
		const fileFormat = document.querySelector("#file-format");
		if (btTextarea) btTextarea.value = data.bt.text || "";
		if (fileFormat) fileFormat.value = data.bt.format || fileFormat.value;
	}
}

// listen for changes to manual input, options, and BT file input, autosave if enabled
function setupAutosaveListeners() {
	const autosaveCheckbox = document.getElementById("autosave");
	const saveIfEnabled = () => {
		if (autosaveCheckbox?.checked) saveAutosaveData(collectInputData());
	};
	document.getElementById("inputs").addEventListener("input", saveIfEnabled);
	document.getElementById("inputs").addEventListener("change", saveIfEnabled);
	document.getElementById("accessible").addEventListener("change", saveIfEnabled);
	document.getElementById("compute-ace").addEventListener("change", saveIfEnabled);
	document.getElementById("smaller-dots").addEventListener("change", saveIfEnabled);
	autosaveCheckbox.addEventListener("change", async () => {
		if (autosaveCheckbox.checked) {
			saveAutosaveData(collectInputData());
		} else {
			clearAutosaveData();
		}
	});
	// BT file input listeners
	const btTextarea = document.querySelector("#paste-upload textarea");
	const fileFormat = document.querySelector("#file-format");
	if (btTextarea) btTextarea.addEventListener("input", saveIfEnabled);
	if (fileFormat) fileFormat.addEventListener("change", saveIfEnabled);
}

// on page load, restore autosave if enabled
async function tryRestoreAutosaveOnLoad() {
	await openAutosaveDB();
	const autosaveCheckbox = document.getElementById("autosave");
	if (autosaveCheckbox?.checked) {
		const data = await loadAutosaveData();
		if (data) restoreInputData(data);
	}
	setupAutosaveListeners();
}

// utilities
function resetElement(el) {
	if (el instanceof HTMLInputElement) el.value = '';
	if (el instanceof HTMLSelectElement) el.selectedIndex = 0;
}

function init() {
	handleSelects();
	handleRemoval();
	document.querySelectorAll('select').forEach(s =>
		s.setAttribute('data-selected', s.value)
	);
	tryRestoreAutosaveOnLoad();
}
init();
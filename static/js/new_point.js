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
}
init();
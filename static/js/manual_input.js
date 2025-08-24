const SPEED_CATEGORY_MAP = new Map([
    [0, -999],
    [34, -2],
    [64, -1],
    [83, 1],
    [96, 2],
    [113, 3],
    [137, 4],
    [157, 5],
    [Number.MAX_SAFE_INTEGER, 5]
]);

const STAGE_SHAPE_MAP = {
    "": "",
    "extratropical cyclone": "triangle",
    "subtropical cyclone": "square",
    "tropical cyclone": "circle"
};

function speedToCat(speed) {
	// use custom scale if selected
	if (typeof getScaleMap === "function" && currentScale && currentScale !== "default" && currentScale !== "accessible") {
		const scale = Array.from(getScaleMap(currentScale).keys()).sort((a, b) => a - b);
		for (let i = 0; i < scale.length; i++) {
			if (speed <= scale[i]) return scale[i];
		}
		return scale[scale.length - 1];
	}
	const thresholds = Array.from(SPEED_CATEGORY_MAP.keys());
	let left = 0, right = thresholds.length - 1;
    
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (speed > thresholds[mid]) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return SPEED_CATEGORY_MAP.get(thresholds[left]) || 5;
}

function stageToShape(stage) {
    return STAGE_SHAPE_MAP[stage.toLowerCase()] || "";
}

function parseCoordinate(input, direction, positiveDir) {
    const value = parseFloat(input);
    return !isNaN(value) ? value * (direction === positiveDir ? 1 : -1) : NaN;
}

document.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const data = [];
    let isValid = true;

    document.querySelectorAll("#inputs .point").forEach(point => {
        const name = point.querySelector(".name").value.trim();
        
        const latInput = point.querySelector("input.latitude").value.trim();
        const latDir = point.querySelector("select.latitude").getAttribute("data-selected").replace("°", "");
        const latitudeValue = parseFloat(latInput);
        
        const longInput = point.querySelector("input.longitude").value.trim();
        const longDir = point.querySelector("select.longitude").getAttribute("data-selected").replace("°", "");
        const longitudeValue = parseFloat(longInput);

        const speedInput = point.querySelector("input.speed").value.trim();
        const unit = point.querySelector("select.speed").getAttribute("data-selected");
        const speed = parseFloat(speedInput);
        
        const stage = point.querySelector(".stage").getAttribute("data-selected");

        if (isNaN(latitudeValue) || isNaN(longitudeValue) || isNaN(speed)) {
            isValid = false;
            return;
        }

        let speedInKnots = speed;
        if (unit === "mph") speedInKnots /= 1.15078;
        else if (unit === "kph") speedInKnots /= 1.852;

        data.push({
            name,
            shape: stageToShape(stage),
            category: speedToCat(speedInKnots),
            latitude: latInput + latDir,
            longitude: longInput + longDir,
            speed: speedInKnots
        });
    });

    if (!isValid) {
        alert("Please fill in all fields with valid numbers");
        return;
    }

    const accessible = document.querySelector("#accessible").checked;
    createMap(data, accessible);
});
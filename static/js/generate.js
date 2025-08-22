function catToColour(cat = -999, type = "tropical", accessible = true) {
	const scaleName = currentScale === "default" ? (accessible ? "accessible" : "default") : currentScale;
	const colorMap = getScaleMap(scaleName);

	if (currentScale !== "default" && currentScale !== "accessible") {
		const key = `${type}-${cat}`;
		return colorMap.get(key) || "#C0C0C0";
	}
	return colorMap.get(cat) || "#C0C0C0";
}

const SCALE_STORAGE_KEY = "trackgen_custom_scales";
let customScales = JSON.parse(localStorage.getItem(SCALE_STORAGE_KEY) || "{}");
let currentScale = "default";

function getScaleList() {
	return ["default", "accessible", ...Object.keys(customScales)];
}

function getScaleMap(scaleName) {
	if (scaleName === "default") {
		return new Map([
			[-999, "#C0C0C0"],
			[-2, "#5EBAFF"],
			[-1, "#00FAF4"],
			[1, "#FFFFCC"],
			[2, "#FFE775"],
			[3, "#FFC140"],
			[4, "#FF8F20"],
			[5, "#FF6060"],
		]);
	}
	if (scaleName === "accessible") {
		return new Map([
			[-999, "#C0C0C0"],
			[-2, "#6ec1ea"],
			[-1, "#4dffff"],
			[1, "#ffffD9"],
			[2, "#ffd98c"],
			[3, "#ff9e59"],
			[4, "#ff738a"],
			[5, "#a188fc"],
		]);
	}
	// custom scale
	const scale = customScales[scaleName];
	if (!scale) return getScaleMap("default");
	const map = new Map();
	scale.forEach(entry => {
		const type = entry.type || "tropical";
		const key = `${type}-${Number(entry.cat)}`;
		map.set(key, entry.color);
	});
	return map;
}

function saveCustomScale(name, entries) {
	customScales[name] = entries;
	localStorage.setItem(SCALE_STORAGE_KEY, JSON.stringify(customScales));
}

function deleteCustomScale(name) {
	delete customScales[name];
	localStorage.setItem(SCALE_STORAGE_KEY, JSON.stringify(customScales));
}

function updateScaleSelector() {
	const selector = document.getElementById("scale-selector");
	selector.innerHTML = "";
	getScaleList().forEach(name => {
		const opt = document.createElement("option");
		opt.value = name;
		opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
		selector.appendChild(opt);
	});
	selector.value = currentScale;
	document.getElementById("delete-scale").style.display =
		(currentScale !== "default" && currentScale !== "accessible") ? "" : "none";
}

function showScaleEditor(scaleName) {
	const editor = document.getElementById("scale-editor");
	const entriesDiv = document.getElementById("scale-entries");
	const unit = document.getElementById("scale-speed-unit").value;

	entriesDiv.innerHTML = "";
	const scale = customScales[scaleName] || [
		{ cat: -999, color: "#C0C0C0", type: "tropical" }
	];

	(scale || []).forEach((entry, idx) => {
		let speed = entry.cat;
		if (speed !== -999) { // don't convert the placeholder!
			if (unit === "mph") speed *= 1.15078;
			else if (unit === "kph") speed *= 1.852;
		}

		const type = entry.type || "tropical"; // default to tropical

		const row = document.createElement("div");
		row.innerHTML = `
			<input type="number" value="${Math.round(speed * 100) / 100}" data-knots="${entry.cat}" class="scale-cat" style="width:60px;" />
			<input type="color" value="${entry.color}" class="scale-color" />
			<input type="text" value="${entry.color}" class="scale-color-hex" maxlength="7" />
			<select class="scale-type">
				<option value="tropical" ${type === 'tropical' ? 'selected' : ''}>Tropical</option>
				<option value="subtropical" ${type === 'subtropical' ? 'selected' : ''}>Subtropical</option>
				<option value="extratropical" ${type === 'extratropical' ? 'selected' : ''}>Extratropical</option>
			</select>
			<button type="button" class="remove-scale-entry" data-idx="${idx}">X</button>
		`;
		entriesDiv.appendChild(row);
	});
	document.getElementById("scale-name").value = scaleName || "";
}

document.addEventListener("DOMContentLoaded", () => {
	updateScaleSelector();
	showScaleEditor("");

	document.getElementById("scale-selector").addEventListener("change", e => {
		currentScale = e.target.value;
		updateScaleSelector();
		showScaleEditor(currentScale !== "default" && currentScale !== "accessible" ? currentScale : "");
	});

	document.getElementById("scale-speed-unit").addEventListener("change", () => {
		const unit = document.getElementById("scale-speed-unit").value;
		document.querySelectorAll("#scale-entries .scale-cat").forEach(input => {
			let knots = parseFloat(input.dataset.knots);
			if (knots === -999) return;

			let displaySpeed = knots;
			if (unit === "mph") displaySpeed *= 1.15078;
			else if (unit === "kph") displaySpeed *= 1.852;
			
			input.value = Math.round(displaySpeed * 100) / 100;
		});
	});

	document.getElementById("delete-scale").addEventListener("click", () => {
		if (currentScale in customScales) {
			deleteCustomScale(currentScale);
			currentScale = "default";
			updateScaleSelector();
			showScaleEditor("");
		}
	});

	document.getElementById("add-scale-entry").addEventListener("click", () => {
		const entriesDiv = document.getElementById("scale-entries");
		const row = document.createElement("div");
		row.innerHTML = `
			<input type="number" value="0" data-knots="0" class="scale-cat" style="width:60px;" />
			<input type="color" value="#000000" class="scale-color" />
			<input type="text" value="#000000" class="scale-color-hex" maxlength="7" />
			<select class="scale-type">
				<option value="tropical" selected>Tropical</option>
				<option value="subtropical">Subtropical</option>
				<option value="extratropical">Extratropical</option>
			</select>
			<button type="button" class="remove-scale-entry">X</button>
		`;
		entriesDiv.appendChild(row);
	});

	document.getElementById("scale-entries").addEventListener("input", e => {
		const target = e.target;
		if (target.classList.contains("scale-color")) {
			target.nextElementSibling.value = target.value;
		} else if (target.classList.contains("scale-color-hex")) {
			const hexValue = target.value;
			if (/^#[0-9a-f]{6}$/i.test(hexValue)) {
				target.previousElementSibling.value = hexValue;
			}
		} else if (target.classList.contains("scale-cat")) {
			const unit = document.getElementById("scale-speed-unit").value;
			let speed = parseFloat(target.value);
			if (unit === "mph") speed /= 1.15078;
			else if (unit === "kph") speed /= 1.852;
			target.dataset.knots = speed;
		}
	});

	document.getElementById("scale-entries").addEventListener("click", e => {
		if (e.target.classList.contains("remove-scale-entry")) {
			e.target.parentElement.remove();
		}
	});

	document.getElementById("save-scale").addEventListener("click", () => {
		const name = document.getElementById("scale-name").value.trim();
		if (!name || name === "default" || name === "accessible") {
			alert("Invalid scale name.");
			return;
		}

		const unit = document.getElementById("scale-speed-unit").value;

		const entries = Array.from(document.querySelectorAll("#scale-entries > div")).map(div => {
			const speedInput = div.querySelector(".scale-cat");
			let speed = Number(speedInput.value);
			
			// convert speed to knots before saving
			if (unit === "mph") speed /= 1.15078;
			else if (unit === "kph") speed /= 1.852;

			return {
				cat: speed,
				color: div.querySelector(".scale-color").value,
				type: div.querySelector(".scale-type").value
			};
		});

		if (entries.length === 0) {
			alert("Add at least one entry.");
			return;
		}
		saveCustomScale(name, entries);
		currentScale = name;
		updateScaleSelector();
		showScaleEditor(name);
	});
});

class MapManager {
    constructor() {
        this.config = {
            mapUrls: {
                "xlarge": "static/media/bg16383.webp",
                "large-nxtgen": "static/media/bg21600-nxtgen.jpg",
                "large": "static/media/bg12000.jpg",
                "blkmar": "static/media/bg13500-blkmar.jpg",
                "normal": "static/media/bg8192.png",
            },
            selectors: {
                mapIndicator: "#map-indicator",
                loader: "#map-indicator .loader",
                statusIcon: "#map-indicator ion-icon",
                buttons: ".generate",
                mapSelector: "#map-selector",
                closeButton: "#close",
                output: "#output",
                mainLoader: "#loader",
                imageContainer: "#image-container"
            },
            states: {
                success: "#70c542"
            }
        };

        this.state = {
            loaded: false,
            loading: false,
            currentMap: null,
            mapCache: new Map(),
            domElements: {},
            loadCallbacks: [],
            offscreenCanvasSupported: typeof OffscreenCanvas !== 'undefined'
        };

        this.cacheElements();

        this.blueMarble = new Image();
        this.blueMarble.crossOrigin = "anonymous";

        this.customMapURLs = new Set();

        if (this.state.offscreenCanvasSupported) {
            this.canvas = new OffscreenCanvas(1, 1);
        } else {
            this.canvas = document.createElement("canvas");
        }

        this.handleMapChange = this.handleMapChange.bind(this);
        this.handleButtonClick = this.handleButtonClick.bind(this);
        this.handleMapLoad = this.handleMapLoad.bind(this);
        this.handleMapError = this.handleMapError.bind(this);
        this.handleCloseButton = this.handleCloseButton.bind(this);

        this.init();
        this.showMapIndicator();
    }

    cacheElements() {
        const selectors = this.config.selectors;
        const elements = this.state.domElements;

        for (const [key, selector] of Object.entries(selectors)) {
            if (selector.startsWith('#')) {
                elements[key] = document.getElementById(selector.slice(1));
            } else {
                elements[key] = document.querySelectorAll(selector);
            }
        }
    }

    init() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        const elements = this.state.domElements;

        elements.mapSelector.addEventListener('change', this.handleMapChange);

        elements.buttons.forEach(button => {
            button.addEventListener("click", () => {
                this.handleButtonClick(button.dataset.size);
            });
        });

        this.blueMarble.addEventListener('load', this.handleMapLoad);
        this.blueMarble.addEventListener('error', this.handleMapError);

        elements.closeButton.addEventListener("click", this.handleCloseButton);

        const customUpload = document.getElementById('custom-map-upload');
        if (customUpload) {
            customUpload.addEventListener('change', (e) => this.handleCustomMapUpload(e));
        }
    }

    handleCloseButton() {
        this.state.domElements.imageContainer.classList.add("hidden");
        if (mapManager) {
            mapManager.hideLoader();
            mapManager.state.loading = false;
        }
    }

    handleCustomMapUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            alert('Please upload a valid image file.');
            event.target.value = '';
            return;
        }

        this.clearCustomMaps();

        const objectURL = URL.createObjectURL(file);
        this.customMapURLs.add(objectURL);

        const option = new Option(file.name, objectURL);
        this.state.domElements.mapSelector.add(option);
        this.state.domElements.mapSelector.value = objectURL;

        this.config.mapUrls[objectURL] = objectURL;
        this.loadMap(objectURL);
    }

    clearCustomMaps() {
        Array.from(this.state.domElements.mapSelector.options)
            .filter(opt => this.customMapURLs.has(opt.value))
            .forEach(opt => opt.remove());

        this.customMapURLs.forEach(url => URL.revokeObjectURL(url));
        this.customMapURLs.clear();
    }

    showMapIndicator() {
        const mapIndicator = document.querySelector(this.config.selectors.mapIndicator);
        if (mapIndicator) {
            mapIndicator.style.display = "flex";
        }
    }

    handleMapChange() {
        const size = this.state.domElements.buttons[0].dataset.size;
        this.loadMap(size);
    }

    handleButtonClick(size) {
        this.loadMap(size);
        this.showLoader();
        this.updateStatus('loading');
    }

    handleMapLoad() {
        this.state.loaded = true;
        this.state.loading = false;
        this.hideLoader();
        this.updateStatus('success');

        this.state.loadCallbacks.forEach(callback => callback());
        this.state.loadCallbacks = [];

        Array.from(this.state.domElements.mapSelector.options)
            .filter(opt => opt.value.startsWith('blob:') && !this.customMapURLs.has(opt.value))
            .forEach(opt => opt.remove());
    }

    handleMapError(error) {
        this.state.loading = false;
        console.error('Yikes. Something went wrong.', error);
        this.hideLoader();
        this.updateStatus('error');
    }

    loadMap(size) {
        const mapUrl = this.getMapUrl(size);

        if (mapUrl !== this.state.currentMap) {
            this.state.loaded = false;
            this.state.loading = true;
            this.state.currentMap = mapUrl;

            if (this.state.mapCache.has(mapUrl)) {
                this.blueMarble = this.state.mapCache.get(mapUrl);
                this.state.loaded = true;
                this.state.loading = false;
                this.hideLoader();
                this.updateStatus('success');
            } else {
                this.showLoader();
                this.blueMarble.src = mapUrl;
                this.state.mapCache.set(mapUrl, this.blueMarble);
            }
        }
    }

    getMapUrl(size) {
        const { selectedIndex, options } = this.state.domElements.mapSelector;
        const mapType = options[selectedIndex].value;
        return this.config.mapUrls[mapType] || this.config.mapUrls[size];
    }

    showLoader() {
        if (this.state.domElements.loader) {
            this.state.domElements.loader.style.display = "block";
        }

        const mapIndicator = document.querySelector(this.config.selectors.mapIndicator);
        if (mapIndicator) {
            const loader = mapIndicator.querySelector('.loader');
            if (loader) {
                loader.style.display = "block";
            }
        }
    }

    hideLoader() {
        if (this.state.domElements.loader) {
            this.state.domElements.loader.style.display = "none";
        }

        const mapIndicator = document.querySelector(this.config.selectors.mapIndicator);
        if (mapIndicator) {
            const loader = mapIndicator.querySelector('.loader');
            if (loader) {
                loader.style.display = "none";
            }
        }
    }

    updateStatus(status) {
        const statusIcon = document.querySelector(this.config.selectors.statusIcon);
        if (statusIcon) {
            if (status === 'loading') {
                statusIcon.style.color = "#f1c40f";
                if (statusIcon.getAttribute("name") !== "map-outline") {
                    statusIcon.setAttribute("name", "map-outline");
                }
            } else if (status === 'success') {
                statusIcon.style.color = this.config.states.success;
                if (statusIcon.getAttribute("name") !== "map-outline") {
                    statusIcon.setAttribute("name", "map-outline");
                }
            } else {
                statusIcon.style.color = "red";
                statusIcon.setAttribute("name", "alert-circle-outline");
            }
        }
    }

    onMapLoad() {
        return new Promise((resolve) => {
            if (this.state.loaded) {
                resolve();
            } else {
                this.state.loadCallbacks.push(resolve);
            }
        });
    }

    getContext() {
        return this.canvas.getContext("2d");
    }

    transferToImageBitmap() {
        if (this.state.offscreenCanvasSupported) {
            return this.canvas.transferToImageBitmap();
        }
        return null;
    }

    toDataURL() {
        if (this.state.offscreenCanvasSupported) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.canvas.width;
            tempCanvas.height = this.canvas.height;
            const tempCtx = tempCanvas.getContext('2d');

            const bitmap = this.transferToImageBitmap();
            tempCtx.drawImage(bitmap, 0, 0);
            bitmap.close();

            return tempCanvas.toDataURL();
        } else {
            return this.canvas.toDataURL();
        }
    }
}

// Usage
const mapManager = new MapManager();

function normalizeLongitude(lng) {
    return ((lng + 180) % 360 + 360) % 360 - 180;
}

function createMap(data, accessible) {
    const elements = mapManager.state.domElements;
    const output = elements.output;
    const loader = elements.mainLoader;
    const closeButton = elements.closeButton;
    const imageContainer = elements.imageContainer;
    const smallerDotsCheckbox = document.getElementById("smaller-dots");

    closeButton.classList.remove("hidden");
    output.classList.add("hidden");
    loader.classList.remove("hidden");
    imageContainer.classList.remove("hidden");

    mapManager.showLoader();
    mapManager.updateStatus('loading');

    const canvas = mapManager.canvas;
    const ctx = mapManager.getContext();

    const shapeDrawers = {
        triangle: (ctx, x, y, dotSize) => {
            const side = dotSize * Math.sqrt(3);
            const bis = side * (Math.sqrt(3) / 2);
            ctx.moveTo(x, y - (2 * bis) / 3);
            ctx.lineTo(x - side / 2, y + bis / 3);
            ctx.lineTo(x + side / 2, y + bis / 3);
            ctx.closePath();
        },
        square: (ctx, x, y, dotSize) => {
            const size = dotSize / Math.sqrt(2);
            ctx.rect(x - size, y - size, 2 * size, 2 * size);
        },
        circle: (ctx, x, y, dotSize) => {
            ctx.arc(x, y, dotSize, 0, 2 * Math.PI);
        }
    };

    mapManager.onMapLoad()
        .then(() => {
            const FULL_WIDTH = mapManager.blueMarble.width;
            const FULL_HEIGHT = mapManager.blueMarble.height;

            const dotSizeFactor = smallerDotsCheckbox.checked ? 2.35 / Math.PI : 1;
            const lineSizeFactor = smallerDotsCheckbox.checked ? 1.5 / Math.PI : 1;
            const DOT_SIZE = (0.29890625 / 360) * FULL_WIDTH * dotSizeFactor;
            const LINE_SIZE = (0.09 / 360) * FULL_WIDTH * lineSizeFactor;

            let minLat = Infinity, maxLat = -Infinity;
            let minRawLng = Infinity, maxRawLng = -Infinity;
            let easternmostLng = -Infinity, westernmostLng = Infinity;

            const processedData = data.map((point) => {
                const tmpLat = Number(point.latitude.slice(0, -1));
                const tmpLong = Number(point.longitude.slice(0, -1));
                const normLong = normalizeLongitude(tmpLong * (point.longitude.endsWith("E") ? 1 : -1));
                let lat = FULL_HEIGHT / 2 - ((tmpLat % 90) * (point.latitude.endsWith("S") ? -1 : 1) * FULL_HEIGHT) / 180;
                let lng = (normLong + 180) / 360 * FULL_WIDTH;

                if (Math.floor(tmpLat / 90) % 2 === 1) lat -= FULL_HEIGHT / 2;

                minLat = Math.min(minLat, lat);
                maxLat = Math.max(maxLat, lat);
                minRawLng = Math.min(minRawLng, normLong);
                maxRawLng = Math.max(maxRawLng, normLong);

                return { ...point, latitude: lat, longitude: lng, rawLongitude: normLong };
            });

            const lngSpan = maxRawLng - minRawLng;
            const crossesIDL = lngSpan > 180;

            processedData.forEach(p => {
                let lng = p.rawLongitude;
                if (crossesIDL && lng < 0) lng += 360;
                easternmostLng = Math.max(easternmostLng, lng);
                westernmostLng = Math.min(westernmostLng, lng);
            });

            if (crossesIDL && westernmostLng > easternmostLng) {
                westernmostLng -= 360; // adjust back if westernmost was shifted
            }

            const centerLng = normalizeLongitude((easternmostLng + westernmostLng) / 2);
            const centerX = (centerLng + 180) / 360 * FULL_WIDTH;

            const halfLngDist = Math.max(
                Math.abs(normalizeLongitude(easternmostLng - centerLng)),
                Math.abs(normalizeLongitude(westernmostLng - centerLng))
            ) * FULL_WIDTH / 360;
            const paddingLng = (FULL_WIDTH * 5) / 360;
            let left = centerX - halfLngDist - paddingLng;
            let right = centerX + halfLngDist + paddingLng;

            let top = minLat - (FULL_HEIGHT * 5) / 180;
            let bottom = maxLat + (FULL_HEIGHT * 5) / 180;

            let width = right - left;
            let height = bottom - top;

            const minWidth = (FULL_HEIGHT * 45) / 180;
            if (width < minWidth) {
                const padding = (minWidth - width) / 2;
                left -= padding;
                right += padding;
                width = right - left;
            }

            if (width < height) {
                const padding = (height - width) / 2;
                left -= padding;
                right += padding;
                width = right - left;
            }

            if (height < width / 1.618033988749894) {
                const padding = (width / 1.618033988749894 - height) / 2;
                top -= padding;
                bottom += padding;
                height = bottom - top;
            }

            canvas.width = width;
            canvas.height = height;

            const drawMapTiles = () => {
                const mapWidth = FULL_WIDTH;
                let mapStartX = Math.floor(left / mapWidth) * mapWidth;
                while (mapStartX > left - mapWidth) mapStartX -= mapWidth;

                for (let offsetX = mapStartX; offsetX < right + mapWidth; offsetX += mapWidth) {
                    const srcX = (offsetX % mapWidth + mapWidth) % mapWidth;
                    const destX = offsetX - left;
                    const drawWidth = Math.min(mapWidth - srcX, right - offsetX);
                    if (drawWidth > 0 && destX < width) {
                        ctx.drawImage(
                            mapManager.blueMarble,
                            srcX, top,
                            drawWidth, height,
                            destX, 0,
                            drawWidth, height
                        );
                    }
                }
            };

            const adjustedData = processedData.map(p => ({
                ...p,
                latitude: p.latitude - top,
                longitude: p.longitude - left
            }));

            const namedTracks = adjustedData.reduce((acc, point) => {
                (acc[point.name] ??= []).push(point);
                return acc;
            }, {});

            const pointGroups = adjustedData.reduce((map, point) => {
                const key = `${catToColour(point.category, point.type, accessible)}|${point.shape}`;
                if (!map.has(key)) {
                    map.set(key, []);
                }
                map.get(key).push(point);
                return map;
            }, new Map());

            const drawTracks = () => {
                ctx.lineWidth = LINE_SIZE;
                ctx.strokeStyle = "white";

                Object.values(namedTracks).forEach(track => {
                    if (track.length < 1) return;

                    track.forEach((point, index) => {
                        if (index === 0) return;

                        ctx.beginPath();
                        const prevPoint = track[index - 1];
                        let currX = point.longitude;
                        let currY = point.latitude;
                        let rawDx = normalizeLongitude(point.rawLongitude - prevPoint.rawLongitude);

                        if (Math.abs(rawDx) > 180) {
                            rawDx = rawDx > 0 ? rawDx - 360 : rawDx + 360;
                        }

                        currX = prevPoint.longitude + (rawDx * FULL_WIDTH / 360);

                        ctx.moveTo(prevPoint.longitude, prevPoint.latitude);
                        ctx.lineTo(currX, currY);

                        if (crossesIDL) {
                            if (currX < 0) {
                                ctx.moveTo(prevPoint.longitude + FULL_WIDTH, prevPoint.latitude);
                                ctx.lineTo(currX + FULL_WIDTH, currY);
                            } else if (currX > width) {
                                ctx.moveTo(prevPoint.longitude - FULL_WIDTH, prevPoint.latitude);
                                ctx.lineTo(currX - FULL_WIDTH, currY);
                            }
                        }

                        ctx.stroke();
                    });
                });
            };

            const drawPoints = () => {
                pointGroups.forEach((points, key) => {
                    const [color, shape] = key.split('|');
                    ctx.fillStyle = color;

                    const drawShapeFunc = shapeDrawers[shape] || shapeDrawers.circle;

                    points.forEach(({ longitude: x, latitude: y }) => {
                        const drawPoint = (drawX) => {
                            ctx.beginPath();
                            drawShapeFunc(ctx, drawX, y, DOT_SIZE);
                            ctx.fill();
                        };

                        drawPoint(x);
                        if (crossesIDL && (x - FULL_WIDTH >= 0 || x + FULL_WIDTH < width)) {
                            drawPoint(x - FULL_WIDTH);
                            drawPoint(x + FULL_WIDTH);
                        }
                    });
                });
            };

            drawMapTiles();
            drawTracks();
            drawPoints();

            output.src = mapManager.toDataURL();
            loader.classList.add("hidden");
            output.classList.remove("hidden");

            // if map generation is successful, hide the loader icon
            mapManager.hideLoader();
            mapManager.updateStatus('success');
            mapManager.state.loading = false;
        })
        .catch((error) => {
            console.error("Error generating map:", error);
            loader.classList.add("hidden");

            mapManager.hideLoader();
            mapManager.updateStatus('error');
            mapManager.state.loading = false;
        });
}
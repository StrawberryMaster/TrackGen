const domElements = {
	accessible: document.querySelector("#accessible"),
	fileFormat: document.querySelector("#file-format"),
	pasteTextarea: document.querySelector("#paste-upload textarea"),
	fileInput: document.querySelector("#file-input")
};

const parsers = {
	hurdat: parseHurdat,
	atcf: parseAtcf,
	ibtracs: parseIbtracs,
	rsmc: parseRsmc,
	storms: parseStorms
};

function mapFromFile(data, type, accessible) {
	const parser = parsers[type.toLowerCase()];
	if (!parser) return;

	try {
		const parsed = parser(data.trim());
		createMap(parsed, accessible);
	} catch (error) {
		alert(`Jeepers! Error parsing ${type} data: ${error.message}.`);
	}
}

document.querySelector("#paste-upload").addEventListener("submit", async (e) => {
	e.preventDefault();
	const accessible = document.querySelector("#accessible").checked;
	const textarea = document.querySelector("#paste-upload textarea");
	let data = textarea.value.trim();
	const type = document.querySelector("#file-format").getAttribute("data-selected").toLowerCase();

	if (isValidUrl(data)) {
		try {
			// for URLs and pastebin-like services
			const proxyUrl = 'https://api.allorigins.win/raw?url=';
			const targetUrl = ensureRawUrl(data);

			const response = await fetch(proxyUrl + encodeURIComponent(targetUrl), {
				headers: {
					'X-Requested-With': 'XMLHttpRequest'
				}
			});

			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			data = await response.text();
		} catch (error) {
			alert(`Jinkies! Failed to fetch data from URL: ${error}\nTip: try pasting the raw data instead.`);
			return;
		}
	}

	mapFromFile(data, type, accessible);
});

const isValidUrl = (str) => {
	try {
		new URL(str);
		return true;
	} catch {
		return false;
	}
};

const ensureRawUrl = (url) => {
	const urlObj = new URL(url);

	// convert pastebin.com/abc123 to pastebin.com/raw/abc123
	if (urlObj.hostname === 'pastebin.com' && !urlObj.pathname.startsWith('/raw')) {
		return `https://pastebin.com/raw${urlObj.pathname}`;
	}

	// convert gist.github.com/abc123 to gist.githubusercontent.com/abc123/raw
	if (urlObj.hostname === 'github.com' && !urlObj.pathname.includes('/raw/')) {
		return url.replace('/blob/', '/raw/');
	}

	return url;
};

domElements.fileInput.addEventListener("change", (e) => {
	const files = Array.from(e.target.files);
	if (!files.length) return;

	files.forEach(file => {
		const fr = new FileReader();
		fr.onload = (evt) => {
			try {
				mapFromFile(evt.target.result,
					domElements.fileFormat.getAttribute("data-selected").toLowerCase(),
					domElements.accessible.checked
				);
			} finally {
				if (file === files[files.length - 1]) {
					domElements.fileInput.value = "";
				}
			}
		};
		fr.onerror = () => alert("Zoinks! File could not be read.");
		fr.readAsText(file, "UTF-8");
	});
});
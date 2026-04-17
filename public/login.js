"use strict";

document.getElementById("login-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const tokenEl = document.getElementById("token");
	const errEl = document.getElementById("err");
	errEl.textContent = "";
	try {
		const res = await fetch("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: tokenEl.value }),
		});
		if (res.ok) {
			window.location.href = "/";
			return;
		}
		errEl.textContent = res.status === 401 ? "Invalid token" : "Login failed";
	} catch (err) {
		errEl.textContent = "Network error";
	}
});

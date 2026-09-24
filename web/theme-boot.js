// Applies the saved theme before first paint so the page never flashes.
try {
  var theme = localStorage.getItem("jev-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch (error) {}

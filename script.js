// --- Premium Global Dark Mode Theme & Utility Manager ---

(function() {
    // 1. Theme initialization logic (run immediately to prevent flash of light theme!)
    const currentTheme = localStorage.getItem('theme') || 'light';
    if (currentTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    }

    // 2. Inject floating theme toggle when DOM is ready
    document.addEventListener('DOMContentLoaded', () => {
        // Create the theme toggle container
        const toggleContainer = document.createElement('div');
        toggleContainer.id = 'theme-toggle-container';
        toggleContainer.style.cssText = `
            position: fixed;
            bottom: 25px;
            right: 25px;
            z-index: 9999;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // Create the premium theme toggle button
        const toggleButton = document.createElement('button');
        toggleButton.id = 'theme-toggle-btn';
        toggleButton.title = 'Toggle Dark/Light Mode';
        toggleButton.style.cssText = `
            width: 50px;
            height: 50px;
            border-radius: 50%;
            background: ${currentTheme === 'dark' ? 'linear-gradient(135deg, #f39c12, #e67e22)' : 'linear-gradient(135deg, #1a5276, #2980b9)'};
            border: 2px solid rgba(255, 255, 255, 0.4);
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
            color: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            outline: none;
        `;

        // Create inner icon
        const icon = document.createElement('i');
        icon.className = currentTheme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
        toggleButton.appendChild(icon);
        toggleContainer.appendChild(toggleButton);
        document.body.appendChild(toggleContainer);

        // Hover animations
        toggleButton.addEventListener('mouseenter', () => {
            toggleButton.style.transform = 'scale(1.15) rotate(15deg)';
            toggleButton.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.4)';
        });

        toggleButton.addEventListener('mouseleave', () => {
            toggleButton.style.transform = 'scale(1) rotate(0deg)';
            toggleButton.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.3)';
        });

        // Click handler to toggle theme
        toggleButton.addEventListener('click', () => {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            if (isDark) {
                document.documentElement.removeAttribute('data-theme');
                localStorage.setItem('theme', 'light');
                icon.className = 'fa-solid fa-moon';
                toggleButton.style.background = 'linear-gradient(135deg, #1a5276, #2980b9)';
            } else {
                document.documentElement.setAttribute('data-theme', 'dark');
                localStorage.setItem('theme', 'dark');
                icon.className = 'fa-solid fa-sun';
                toggleButton.style.background = 'linear-gradient(135deg, #f39c12, #e67e22)';
            }
        });
    });
})();

// Legacy/original script helper if any page expects it
function goToMain(){
    location.href = "main.html";
}

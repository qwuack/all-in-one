### show message error/success/warning
1. html
<div id="your-id-error" class="login-error" style="display:none;"></div>

2. js
const yourIdErrorEl = document.getElementById('your-id-error');
const showYourIdMessage = (msg, type = "error") => {
    if (!yourIdErrorEl) return;

    if (!msg) {
        yourIdErrorEl.style.display = 'none'; // hide completely
        yourIdErrorEl.classList.remove("login-error", "login-success", "login-warning");
        return;
    }

    yourIdErrorEl.textContent = msg;
    yourIdErrorEl.style.display = 'block';

    yourIdErrorEl.classList.remove("login-error", "login-success", "login-warning");
    if (type === "success") yourIdErrorEl.classList.add("login-success");
    else if (type === "warning") yourIdErrorEl.classList.add("login-warning");
    else yourIdErrorEl.classList.add("login-error");
};
showYourIdMessage('Your message', 'success');
showYourIdMessage('Your message', 'error');
showYourIdMessage('Your message', 'warning');
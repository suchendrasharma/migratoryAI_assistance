const STORAGE_KEY = 'migratoryai_waitlist_signups';

function loadSignups() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    return [];
  }
}

function saveSignups(signups) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signups));
}

function setFeedback(message, type) {
  const feedback = document.getElementById('form-feedback');
  feedback.textContent = message;
  feedback.dataset.state = type;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function openModal(message) {
  const modal = document.getElementById('signup-modal');
  const modalText = document.getElementById('signup-modal-text');

  if (!modal || !modalText) {
    return;
  }

  modalText.textContent = message;
  modal.classList.add('is-visible');
  modal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  const modal = document.getElementById('signup-modal');

  if (!modal) {
    return;
  }

  modal.classList.remove('is-visible');
  modal.setAttribute('aria-hidden', 'true');
}

function initSignupCapture() {
  const form = document.getElementById('signup-form');
  const emailInput = document.getElementById('email');
  const modal = document.getElementById('signup-modal');
  const closeButton = document.getElementById('signup-modal-close');
  const actionButton = document.getElementById('signup-modal-action');

  if (!form || !emailInput) {
    return;
  }

  let signups = loadSignups();

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const email = emailInput.value.trim().toLowerCase();

    if (!isValidEmail(email)) {
      setFeedback('Enter a valid email address to join the waitlist.', 'error');
      return;
    }

    const exists = signups.some((signup) => signup.email === email);

    if (exists) {
      setFeedback('That email is already registered on this device.', 'warning');
      return;
    }

    const nextSignup = {
      email,
      createdAt: new Date().toISOString(),
    };

    signups = [...signups, nextSignup];
    saveSignups(signups);

    form.reset();
    setFeedback('Email captured successfully.', 'success');
    openModal('Thanks for registering. We will reach out with tester updates and limited access information.');
  });

  if (closeButton) {
    closeButton.addEventListener('click', closeModal);
  }

  if (actionButton) {
    actionButton.addEventListener('click', closeModal);
  }

  if (modal) {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeModal();
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal();
    }
  });
}

document.addEventListener('DOMContentLoaded', initSignupCapture);

const { saveWaitlistSignup } = require('./_waitlistStore');

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

module.exports = async function waitlistHandler(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const email = typeof request.body?.email === 'string'
      ? request.body.email.trim().toLowerCase()
      : '';

    if (!isValidEmail(email)) {
      sendJson(response, 400, { error: 'A valid email address is required.' });
      return;
    }

    const totalRegistrations = await saveWaitlistSignup(email);

    sendJson(response, 200, {
      success: true,
      message: 'Signup captured successfully.',
      totalRegistrations,
    });
  } catch (error) {
    sendJson(response, 500, {
      error: 'Unable to save signup right now.',
      detail: error.message,
    });
  }
};

const { countWaitlistSignups } = require('./_waitlistStore');

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

module.exports = async function waitlistCountHandler(request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const adminToken = process.env.WAITLIST_ADMIN_TOKEN;
  const requestToken = request.headers['x-admin-token'];

  if (adminToken && requestToken !== adminToken) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const totalRegistrations = await countWaitlistSignups();
    sendJson(response, 200, { totalRegistrations });
  } catch (error) {
    sendJson(response, 500, {
      error: 'Unable to read signup count right now.',
      detail: error.message,
    });
  }
};

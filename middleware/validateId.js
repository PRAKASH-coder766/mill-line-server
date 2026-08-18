// Any :param in an Express route that ends up in a numeric SQL column needs
// validation before it reaches a query — otherwise a malformed value (a
// literal "undefined", a stray string, a stale/bad client value) throws a
// raw Postgres type error deep inside an async handler. Found during Module
// 13 integration testing: this crashed the entire server once (before a
// global safety net was added) and left requests hanging afterward. This
// middleware stops it at the door with a clean 400 instead.
function validateIdParams(...paramNames) {
  return (req, res, next) => {
    for (const name of paramNames) {
      const value = req.params[name];
      if (value !== undefined && (!/^\d+$/.test(value))) {
        return res.status(400).json({ error: `Invalid ${name} parameter.` });
      }
    }
    next();
  };
}

module.exports = { validateIdParams };

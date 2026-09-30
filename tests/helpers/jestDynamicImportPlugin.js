/**
 * Metro supports import(), but Jest's CJS runtime does not load the Expo
 * TypeScript modules through Node ESM. Preserve asynchronous namespace-import
 * semantics using Jest's require loader; this plugin is test-only.
 */
module.exports = ({ types: t }) => ({
  name: 'pickpic-jest-dynamic-import',
  visitor: {
    CallExpression(path) {
      if (!t.isImport(path.node.callee)) return;
      // Current application imports use static module paths. Avoid silently
      // changing evaluation timing for computed import expressions.
      if (path.node.arguments.length !== 1 || !t.isStringLiteral(path.node.arguments[0])) {
        throw path.buildCodeFrameError('Jest dynamic imports must use a static module path');
      }
      const namespace = t.callExpression(path.hub.file.addHelper('interopRequireWildcard'), [
        t.callExpression(t.identifier('require'), path.node.arguments),
      ]);
      path.replaceWith(t.callExpression(
        t.memberExpression(
          t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('resolve')), []),
          t.identifier('then'),
        ),
        [t.arrowFunctionExpression([], namespace)],
      ));
    },
  },
});

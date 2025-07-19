// Used by prettierd as a default config
// See nvim/lua/custom/plugins/formatter.lua
module.exports = {
	plugins: ["prettier-plugin-svelte"],
	overrides: [{ files: "*.svelte", options: { parser: "svelte" } }],
};

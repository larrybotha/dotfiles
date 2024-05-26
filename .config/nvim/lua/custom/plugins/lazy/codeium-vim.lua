return {
	-- note, different to codeium.nvim which relies on nvim-cmp

	"Exafunction/codeium.vim",
	init = function()
		require("custom.plugins.codeium-vim")
	end,
}

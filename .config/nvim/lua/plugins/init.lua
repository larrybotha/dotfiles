local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
	vim.fn.system({
		"git",
		"clone",
		"--filter=blob:none",
		"https://github.com/folke/lazy.nvim.git",
		"--branch=stable", -- latest stable release
		lazypath,
	})
end
vim.opt.rtp:prepend(lazypath)

--require("plugins/neodev") -- must be run before lsp
--require("plugins/cmp")
--require("plugins/formatter")
--require("plugins/gitsigns")
--require("plugins/indent-blankline")
--require("plugins/mason") -- must be before lsp
--require("plugins/lsp")
--require("plugins/lspfuzzy")
--require("plugins/neogen")
--require("plugins/null-ls")
--require("plugins/nvim-dap")
--require("plugins/nvim-web-devicons")
--require("plugins/rust-tools")
--require("plugins/telescope")
--require("plugins/treesitter")
--require("plugins/trouble")

require("lazy").setup({
	{
    'wakatime/vim-wakatime',
		lazy = false,
	},

 require('plugins/mellow').lazy_config,
 require('plugins/nnn').lazy_config,
 require('plugins/vim-tmux-navigator').lazy_config,

  require('plugins/telescope').lazy_config,
  require('plugins/fzf').lazy_config,
}, {
  debug = true
})

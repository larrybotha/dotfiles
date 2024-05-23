vim.opt.termguicolors = true -- use gui color attributes instead of cterm attributes
vim.opt.splitright = true -- open split panes to the right of the current pane
vim.opt.splitbelow = true -- open split panes underneath the current pane

vim.opt.backspace = "indent,eol,start" -- allow backspacing over everything in insert mode
vim.opt.linespace = 0 -- No extra spaces between rows

-- use hybrid line numbers
vim.opt.number = true
vim.opt.relativenumber = true

vim.opt.colorcolumn = "85" -- show column length hint for long lines
vim.opt.cursorcolumn = true -- highlight current column
vim.opt.cursorline = true -- highlight current line
vim.opt.hlsearch = true -- highlight search terms
vim.opt.ignorecase = true -- case insensitive search
vim.opt.inccommand = "split" -- show the effects of substitute while typing
vim.opt.incsearch = true -- find as you type search
vim.opt.scrolljump = 5 -- lines to scroll when cursor leaves screen
vim.opt.scrolloff = 5 -- minimum lines to keep above and below cursor
vim.opt.showcmd = true -- show timeout on leader
vim.opt.showmatch = true -- show matching brackets/parenthesis
vim.opt.smartcase = true -- case sensitive when uc present
vim.opt.smartindent = true -- autoindent on new lines
vim.opt.spell = false -- disable spellcheck
vim.opt.wildmenu = true -- show list instead of just completing
vim.opt.wildmode = "list:longest,full" -- command <Tab> completion, list matches, then longest common part, then all.
vim.opt.winminheight = 0 -- windows can be 0 line high
vim.opt.wrap = false -- don't wrap lines

-- a: Suppress "hit-enter" prompt that appears when a command has completed
-- t: Suppress "Terminal" message that appears when you enter a terminal buffer
-- I: Suppress "search hit TOP, continuing at BOTTOM" message that appears when
--  a search wraps around the end of the file.
vim.opt.shortmess = "atI"

vim.opt.winbar = "%=%m %f" -- add filename to winbar aligned to end

vim.opt.swapfile = false
vim.opt.backup = false

local function setSpacing()
	vim.opt.autoindent = true -- indent at the same level of the previous line
	vim.opt.shiftwidth = 2 -- use indents of 2 spaces
	vim.opt.tabstop = 2 -- indent every 2 columns
	vim.opt.softtabstop = 2 -- let backspace delete indent
	vim.opt.expandtab = true
end

vim.api.nvim_create_autocmd({ "VimEnter", "BufNewFile", "BufReadPost" }, {
	callback = setSpacing,
	pattern = "*",
	desc = "Set consistent spacing when starting Neovim or adding files to buffers",
	group = vim.api.nvim_create_augroup("CustomSpaceGroup", {}),
})

-- Configure Python virtual environment for neovim
--
-- Run :checkhealth to determine if python3_host_prog is pointing to the
-- virtualenv python binary
--
-- see :help provider-python for virtualenv config instructions
local python3_host_prog = vim.fn.expand("$HOME/.pyenv/versions/py3nvim/bin/python")

if vim.fn.filereadable(python3_host_prog) then
	vim.g.python3_host_prog = python3_host_prog
else
	print("neovim python virtualenv is not configured")
end

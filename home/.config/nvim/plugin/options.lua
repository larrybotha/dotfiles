local opt = vim.opt

opt.termguicolors = true -- use gui color attributes instead of cterm attributes

opt.backspace = "indent,eol,start" -- allow backspacing over everything in insert mode
opt.linespace = 0 -- No extra spaces between rows

-- use hybrid line numbers
opt.number = true
opt.relativenumber = true

opt.colorcolumn = "85" -- show column length hint for long lines
opt.cursorcolumn = true -- highlight current column
opt.cursorline = true -- highlight current line
opt.hlsearch = true -- highlight search terms
opt.ignorecase = true -- case insensitive search
opt.inccommand = "split" -- show the effects of substitute while typing
opt.incsearch = true -- find as you type search
opt.scrolljump = 5 -- lines to scroll when cursor leaves screen
opt.scrolloff = 5 -- minimum lines to keep above and below cursor
opt.showcmd = true -- show timeout on leader
opt.showmatch = true -- show matching brackets/parenthesis
opt.smartcase = true -- case sensitive when uc present
opt.smartindent = true -- autoindent on new lines
opt.spell = false -- disable spellcheck
opt.splitbelow = true -- open split panes underneath the current pane
opt.splitright = true -- open split panes to the right of the current pane
opt.wildmenu = true -- show list instead of just completing
opt.wildmode = "list:longest,full" -- command <Tab> completion, list matches, then longest common part, then all.
opt.winbar = "%=%m %f" -- add filename to winbar aligned to end
opt.winminheight = 0 -- windows can be 0 line high
opt.wrap = false -- don't wrap lines
opt.winborder = "double" -- use double line for floating window borders

-- a: Suppress "hit-enter" prompt that appears when a command has completed
-- t: Suppress "Terminal" message that appears when you enter a terminal buffer
-- I: Suppress "search hit TOP, continuing at BOTTOM" message that appears when
--  a search wraps around the end of the file.
opt.shortmess = "atI"

opt.swapfile = false
opt.backup = false

opt.formatoptions:remove("o") -- don't have `o` add a comment

-- indentation
opt.autoindent = true -- indent at the same level of the previous line
opt.shiftwidth = 2 -- use indents of 2 spaces
opt.tabstop = 2 -- indent every 2 columns
opt.softtabstop = 2 -- let backspace delete indent
opt.expandtab = true

-- Configure Python virtual environment for neovim
--
-- Run :checkhealth to determine if python3_host_prog is pointing to the
-- virtualenv python binary
--
-- see :help provider-python for virtualenv config instructions
-- The path below is the pynvim path once installed via uv, which installs
-- packages to $XDG_DATA_HOME/../bin
local python3_host_prog = vim.fn.expand("$XDG_DATA_HOME/../bin/pynvim-python")

if vim.fn.filereadable(python3_host_prog) then
	vim.g.python3_host_prog = python3_host_prog
else
	vim.print("python3_host_prog not set - this is required for python deps in Neovim")
	vim.print("see :help provider-python")
end

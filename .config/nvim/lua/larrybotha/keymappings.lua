vim.g.mapleader = ","

-- center the cursor when navigating files
vim.keymap.set("n", "<C-d>", "<C-d>zz")
vim.keymap.set("n", "<C-u>", "<C-u>zz")
vim.keymap.set("n", "n", "nzzzv")
vim.keymap.set("n", "N", "Nzzzv")

-- maintain cursor positioning when joining lines
vim.keymap.set("n", "J", "mzJ`z")

-- j and k navigate through wrapped lines
vim.keymap.set('n', 'k', 'gk')
vim.keymap.set('n', 'j', 'gj')

-- copy text into the void register, only during visual mode,
-- so as not to overwrite the yank register
-- see https://youtu.be/w7i4amO_zaE?si=C5sHtqfMIaKs2aWV&t=1596
vim.keymap.set("x", "<leader>p", [["_dP]])

-- yank into the system clipboard
vim.keymap.set({"n", "v"}, "<leader>y", [["+y]])
vim.keymap.set("n", "<leader>Y", [["+Y]])

-- yank from cursor to EOL the same as C and D do
vim.keymap.set("n", "Y", "y$")

-- navigate using [ and ]
vim.keymap.set("", "[b", ":bprevious<CR>")
vim.keymap.set("", "]b", ":bnext<CR>")
vim.keymap.set("", "[q", ":cprevious<CR>")
vim.keymap.set("", "]q", ":cnext<CR>")
vim.keymap.set("", "[l", ":lprevious<CR>")
vim.keymap.set("", "]l", ":lnext<CR>")

-- visual shifting without exiting visual mode
vim.keymap.set("v", "<", "<gv")
vim.keymap.set("v", ">", ">gv")

-- quickly move lines up and down with <A-J> == ∆ and <A-K> == ˚
vim.keymap.set("n", "∆", ":m .+1<CR>==")
vim.keymap.set("n", "˚", ":m .-2<CR>==")
vim.keymap.set("i", "∆", "<Esc>:m .+1<CR>==gi")
vim.keymap.set("i", "˚", "<Esc>:m .-2<CR>==gi")
vim.keymap.set("v", "∆", ":m '>+1<CR>gv=gv")
vim.keymap.set("v", "˚", ":m '<-2<CR>gv=gv")

-- paste, fix indentation and clear the mark by default
vim.keymap.set("n", "p", "p=`]`<esc>p")

-- quickly move to next and previous buffers
vim.keymap.set("", "<leader>bn", ":bn<CR>")
vim.keymap.set("", "<leader>bp", ":bp<CR>")

-- quick access to this .vimrc
vim.keymap.set("", "<leader>vs", ":source $MYVIMRC<CR>")
vim.keymap.set("", "<leader>vi", ":tabedit ~/.config/nvim<CR>")

-- set all windows to equal width
vim.keymap.set("", "<leader>=", "<C-w>=")

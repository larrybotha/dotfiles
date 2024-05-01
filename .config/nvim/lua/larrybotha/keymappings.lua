vim.g.mapleader = ","

-- clear highlighted searches
vim.keymap.set("n", "<leader>/", ":nohlsearch<CR>", { silent = true })

-- center the cursor when navigating files
vim.keymap.set("n", "<C-d>", "<C-d>zz")
vim.keymap.set("n", "<C-u>", "<C-u>zz")
vim.keymap.set("n", "n", "nzzzv")
vim.keymap.set("n", "N", "Nzzzv")

-- maintain cursor positioning when joining lines
vim.keymap.set("n", "J", "mzJ`z")

-- j and k navigate through wrapped lines
vim.keymap.set("n", "k", "gk")
vim.keymap.set("n", "j", "gj")

-- substitute all occurrences of the word under the cursor
vim.keymap.set("n", "<leader>s", [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]])

-- when in visual mode (this is what 'x' denotes - it excludes selection mode),
-- allow for pasting while placing the highlighted text into the void register,
-- instead of the default register.
-- This ensures that subsequent pastes contain the originally yanked text, and not
-- the replaced text
-- see https://youtu.be/w7i4amO_zaE?si=C5sHtqfMIaKs2aWV&t=1596
vim.keymap.set("x", "<leader>p", [["_dP]])

-- delete text into the void register to prevent overwriting the currently yanked
-- text
vim.keymap.set({ "n", "v" }, "<leader>d", [["_d]])

-- yank into the system clipboard
vim.keymap.set({ "n", "v" }, "<leader>y", [["+y]])
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

-- quickly move to next and previous buffers
vim.keymap.set("", "<leader>bn", ":bn<CR>")
vim.keymap.set("", "<leader>bp", ":bp<CR>")

-- quick access to this .vimrc
vim.keymap.set("", "<leader>vs", ":source $MYVIMRC<CR>")
vim.keymap.set("", "<leader>vi", ":tabedit $MYVIMRC<CR>")

-- set all windows to equal width
vim.keymap.set("", "<leader>=", "<C-w>=")

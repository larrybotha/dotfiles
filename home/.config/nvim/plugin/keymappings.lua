local set = vim.keymap.set

set("n", "<leader>/", ":nohlsearch<CR>", { silent = true, desc = "clear highlighted searches" })

-- center the cursor when navigating files
set("n", "<C-d>", "<C-d>zz", { desc = "page down with centered cursor" })
set("n", "<C-u>", "<C-u>zz", { desc = "page up with centered cursor" })
set("n", "n", "nzzzv", { desc = "next search hit with centered cursor" })
set("n", "N", "Nzzzv", { desc = "previous search hit with centered cursor" })

set("n", "J", "mzJ`z", { desc = "join lines maintaining cursor position" })

-- j and k navigate through wrapped lines
set("n", "k", "gk", { desc = "navigate up through wrapped lines" })
set("n", "j", "gj", { desc = "navigate down through wrapped lines" })

-- substitute all occurrences of the word under the cursor
set("n", "<leader>s", [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]], { desc = "substitute word under cursor" })

-- when in visual mode (this is what 'x' denotes - it excludes selection mode),
-- allow for pasting while placing the highlighted text into the void register,
-- instead of the default register.
-- This ensures that subsequent pastes contain the originally yanked text, and not
-- the replaced text
-- see https://youtu.be/w7i4amO_zaE?si=C5sHtqfMIaKs2aWV&t=1596
set("x", "<leader>p", [["_dP]], { desc = "paste into void register" })

-- delete text into the void register to prevent overwriting the currently yanked
-- text
set({ "n", "v" }, "<leader><leader>d", [["_d]], { desc = "delete into void register" })

-- yank into the system clipboard
set({ "n", "v" }, "<leader>y", [["+y]], { desc = "yank to system clipboard" })
set("n", "<leader>Y", [["+Y]], { desc = "yank to system clipboard" })

-- yank from cursor to EOL the same as C and D do
set("n", "Y", "y$", { desc = "yank to end of line" })

-- navigate using [ and ]
set("", "[b", ":bprevious<CR>", { desc = "previous buffer" })
set("", "]b", ":bnext<CR>", { desc = "next buffer" })
set("", "[q", ":cprevious<CR>", { desc = "previous quickfix entry" })
set("", "]q", ":cnext<CR>", { desc = "next quickfix entry" })
set("", "[l", ":lprevious<CR>", { desc = "previous location list entry" })
set("", "]l", ":lnext<CR>", { desc = "next location list entry" })

-- visual shifting without exiting visual mode
set("v", "<", "<gv", { desc = "indent left without exiting visual mode" })
set("v", ">", ">gv", { desc = "indent right without exiting visual mode" })

-- quickly move lines up and down with <A-J> == ∆ and <A-K> == ˚
set("i", "∆", "<Esc>:m .+1<CR>==gi", { desc = "move line down - <A-J>" })
set("n", "∆", ":m .+1<CR>==", { desc = "move line down - A-J>" })
set("v", "∆", ":m '>+1<CR>gv=gv", { desc = "move selection down - <A-J>" })
set("i", "˚", "<Esc>:m .-2<CR>==gi", { desc = "move line up - <A-K>" })
set("n", "˚", ":m .-2<CR>==", { desc = "move line up - <A-K>" })
set("v", "˚", ":m '<-2<CR>gv=gv", { desc = "move selection up - <A-K>" })

set("", "<leader>vs", ":source $MYVIMRC<CR>", { desc = "source .vimrc" })
set("", "<leader>vi", ":tabedit $MYVIMRC<CR>", { desc = "open .vimrc in tab" })
set("", "<leader>vt", ":vnew | terminal<CR>", { desc = "open terminal in vertical split" })

set("", "<leader>=", "<C-w>=", { desc = "set all windows to equal width" })

set("n", "<leader><leader>x", "<cmd>source %<CR>", { desc = "execute the current file" })

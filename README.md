# Student Wallet (PWA + Supabase) - bản tối ưu điện thoại

## Cấu trúc thư mục
index.html, avalanche-bridge.js, StudentGroupVaultV2.sol, StudentGroupVaultV3.sol, sw.js, manifest.webmanifest, config.js, icons/, schema.sql, schema_update.sql, schema_groups_secure.sql

## Cài đặt (lần đầu)
1. Supabase > SQL Editor: chạy `schema.sql` (hoặc `schema_update.sql` nếu đã chạy schema.sql trước đó).
2. `config.js`: dán Project URL và khóa publishable (khóa Secret tuyệt đối không dán vào đây).
3. Kéo cả thư mục vào app.netlify.com/drop, rồi đặt Site URL trong Supabase > Authentication > URL Configuration là link Netlify (thêm vào Redirect URLs để quên mật khẩu hoạt động).

## Lưu ý về tính năng Nhóm & Chia sẻ
Code dùng thêm các bảng `groups`, `group_members`, `group_budgets`, `group_expenses`, `user_profiles`. Chạy `schema_groups_secure.sql` trong Supabase > SQL Editor để tạo/bổ sung các bảng này cùng chính sách bảo mật (RLS), giới hạn sửa 3 lần ở server và các cột Blockchain. File chạy lại nhiều lần được.

## Cập nhật app
Mỗi lần sửa code, tăng số phiên bản `V` trong sw.js (hiện là `sw-v26`) rồi tải lại lên Netlify.

## Trên điện thoại
- Dưới 860px: thanh menu dưới cùng (Tổng quan, Lịch sử, nút + , Ngân sách, Mục khác), thanh tiêu đề trên cùng có chuông và bánh răng.
- Nút + mở bảng chọn Quét hóa đơn hoặc Thêm thủ công. Báo cáo và Nhóm nằm ở Mục khác.
- Cài đặt và thông báo mở dạng bảng trượt từ dưới lên.
- Trang Quét hóa đơn có nút Chụp ảnh (mở camera sau) và Chọn từ thư viện.
- Bàn phím mở thì thanh menu dưới tự ẩn; ô nhập dùng cỡ chữ 16px để iPhone không tự phóng to.
- Android: menu bánh răng có mục Cài ứng dụng khi trình duyệt cho phép. iPhone: dùng Safari, Chia sẻ > Thêm vào Màn hình chính.

## Contract Blockchain V2 (quỹ riêng từng nhóm + niêm phong không rút tiền)
1. Mở remix.ethereum.org, tạo file `StudentGroupVaultV2.sol`, dán nội dung file cùng tên, compiler 0.8.20 trở lên.
2. Deploy với môi trường Injected Provider (Core/MetaMask) trên mạng Avalanche Fuji, không cần tham số.
3. Địa chỉ contract V2 đã được điền sẵn trong `CONTRACT_ADDRESS_V2` ở đầu `avalanche-bridge.js` (0x249f...2a4f, Avalanche Fuji). Nếu deploy lại, thay địa chỉ mới rồi tăng số phiên bản trong sw.js.
4. Mỗi thành viên phải góp tối thiểu 0.01 AVAX cho nhóm mới được tạo yêu cầu, duyệt chi hoặc niêm phong. Số dư V1 không tự chuyển sang V2.

## Hoàn tiền từ quỹ nhóm
- Mỗi thành viên nhập ví Avalanche ở trang Nhóm & Chia sẻ (thẻ "Ví Avalanche của bạn").
- Khoản chi được ghi vào lịch sử nhóm trước. Tại khoản chi đó, nút "Đề nghị hoàn từ quỹ" tạo yêu cầu chuyển tiền về ví của người đã mua, kèm hash hóa đơn. Khoản hoàn không tạo thêm dòng chi tiêu.
- Thành viên đã góp quỹ bấm "Đồng ý chi" trong mục Quỹ chung. Đủ đa số và quỹ đủ tiền thì khoản hoàn tự chuyển; nếu đã đủ phiếu nhưng quỹ chưa đủ, thành viên có thể góp thêm rồi bấm "Quỹ đã đủ · Chuyển tiền".
- Mục Quỹ chung hiển thị riêng số dư và số tiền đã góp của từng thành viên. Các khoản góp không cộng vào báo cáo chi tiêu.
- Đã áp dụng `schema_groups_secure.sql` cho Supabase project đang dùng. Nếu triển khai sang project Supabase khác thì chạy lại file này trước.

## Bản contract V3 cho demo UniHack
- `StudentGroupVaultV2.sol` và địa chỉ hiện tại vẫn được giữ để tương thích. V2 chưa xác thực thành viên on-chain và chưa chặn trùng theo mã khoản chi.
- `StudentGroupVaultV3.sol` bổ sung đăng ký nhóm bằng chữ ký của ví trưởng nhóm, danh sách ví thành viên được phép, và khóa `expenseKey` để chặn yêu cầu hoàn trùng cho cùng một khoản chi.
- Đã deploy V3 lên Avalanche Fuji: `0xfcCc67Dd8642640F4b17981aF349b4C092252F21`. Địa chỉ đã được điền vào `CONTRACT_ADDRESS_V3`; mã nguồn hiện dùng cache `sw-v26`.
- Mỗi thành viên cần lưu ví nhận tiền. Trưởng nhóm kết nối đúng ví đã lưu và bấm **Đăng ký / đồng bộ ví thành viên trên Fuji**. Tất cả thành viên trong danh sách phải có địa chỉ ví hợp lệ trước lần đăng ký đầu tiên.
- V3 là contract mới, không tự nhận số dư hoặc yêu cầu từ V2. Chỉ dùng AVAX test trên Fuji trong demo.
- Đã demo trên Fuji: đồng bộ ví thành viên, góp 0.031 AVAX, tạo yêu cầu hoàn 20,000 VND (0.030769 AVAX), duyệt 1/1 và chuyển tiền thành công. Lần demo có 1 thành viên góp quỹ nên ngưỡng duyệt là 1; cần thêm ví thành viên thứ hai để minh họa duyệt đa chữ ký.
- Bản `v26` sửa nhận diện ngày hóa đơn: chấp nhận ngày quá khứ, hiểu các dạng ngày ISO và ngày Việt Nam; nếu không đọc được ngày thì để trống để người dùng nhập, không tự ghi hôm nay.
- Bản sửa ngày v26 đã nằm trong mã nguồn; cần xuất bản v26 lên Netlify để trang live nhận bản sửa này.


// Luật chơi dùng chung cho mọi client. Host và client phải cùng giá trị.
export const RULES = {
  SEATS: 6,
  PLATE: 120,     // số pea ban đầu trên mỗi đĩa
  WIN: 100,       // ăn đủ số này thì thắng
  FORK_MAX: 15,   // nĩa 4 răng, mỗi răng giữ tối đa 4 pea (ô cuối để trống)
  POKE: 0.4,      // giây cho một lần xiên: hạ tay xuống đĩa, đâm, đưa tay về chỗ cũ
  POKE_HIT: 0.47, // răng nĩa chạm đĩa ở 47% thời gian xiên (khớp animation trong Character.update)
  EAT: 0.6,       // giây đưa cả nĩa lên miệng
  COUNTDOWN: 3,   // giây đếm ngược 3-2-1 trước khi mafia bắt đầu đọc báo
  WARN: 0.4,      // giây mafia hạ báo (tín hiệu cảnh báo) trước khi nhìn
  FAKE: 0.25,     // xác suất hạ báo rồi đọc tiếp (đánh lừa)
  AFTER_SHOT: 3.9,// giây từ lệnh shot tới lúc đọc báo tiếp: lên đạn + ngắm 1.8s, giữ súng chĩa vào nạn nhân 2s
  ROUNDS_MAX: 5,  // chủ phòng chọn số trận 1..ROUNDS_MAX, cộng điểm qua các trận
  BONUS_RATE: 0.5,// còn sống lúc hết trận: thưởng BONUS_RATE × số pea đã ăn trong trận...
  BONUS_MAX: 20,  // ...tối đa BONUS_MAX điểm
  BOARD: 7,       // giây hiện bảng điểm giữa hai trận
};

// Điểm thưởng sống sót tỉ lệ với số pea đã ăn, nên người ngồi im (0 pea) không có thưởng.
// Với BONUS_RATE 0.5: người sống sót ăn 30 pea được 45 điểm, người chết lúc đã ăn 46 pea được 46,
// tức là sống sót chỉ lợi hơn khi đã ăn nhiều. Trần BONUS_MAX đạt ở 40 pea; người ăn đủ 100 pea
// được tối đa 120 (thêm 1 lần ăn cuối có thể vượt 100 vài pea).
export function survivorBonus(peas) {
  return Math.min(RULES.BONUS_MAX, Math.floor(peas * RULES.BONUS_RATE));
}

// Số pea dính lên nĩa sau một lần xiên: 1 (60%) hoặc 2 (40%).
export function pokeYield() {
  return Math.random() < 0.6 ? 1 : 2;
}

export const BOT_NAMES = ['Vinnie', 'Sal', 'Paulie', 'Luca', 'Nico', 'Tony'];

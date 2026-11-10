const menu = [
	{
		name: 'The District Smash', price: 14.5, category: 'burgers',
		detail: 'Double smash patty · cheddar · house sauce',
		image: '/assets/food/burger-classic.jpg',
		imageAlt: 'Juicy double cheeseburger with lettuce and tomato', tag: 'Bestseller'
	},
	{
		name: 'Double Trouble Burger', price: 16.5, category: 'burgers',
		detail: 'Two patties · caramelized onion · pickles',
		image: '/assets/food/burger-double.jpg',
		imageAlt: 'Double cheeseburger stacked with pickles and sauce', tag: 'Crowd favorite'
	},
	{
		name: 'Garden Margherita', price: 15, category: 'pizza',
		detail: 'San Marzano tomato · mozzarella · fresh basil',
		image: '/assets/food/pizza-margherita.jpg',
		imageAlt: 'Freshly baked pizza topped with herbs and cheese', tag: 'Veggie'
	},
	{
		name: 'Hot Honey Chicken Pizza', price: 18, category: 'pizza',
		detail: 'Roast chicken · chili honey · red onion',
		image: '/assets/food/pizza-slice.jpg',
		imageAlt: 'Golden pizza with chicken and fresh toppings', tag: 'House special'
	},
	{
		name: 'Miso Ramen Bowl', price: 16, category: 'bowls',
		detail: 'Slow broth · prawns · greens · soft egg',
		image: '/assets/food/noodles-ramen.jpg',
		imageAlt: 'Ramen bowl with prawns, greens and soft-boiled egg', tag: 'Comfort food'
	},
	{
		name: 'Green Goddess Bowl', price: 14, category: 'bowls',
		detail: 'Grains · avocado · charred greens · sesame',
		image: '/assets/food/grain-bowl.jpg',
		imageAlt: 'Colorful grain bowl filled with greens and vegetables', tag: 'Plant powered'
	},
	{
		name: 'Market Day Salad', price: 12.5, category: 'salads',
		detail: 'Seasonal greens · crisp vegetables · lemon dressing',
		image: '/assets/food/market-salad.jpg',
		imageAlt: 'Fresh market salad with leafy greens and vegetables', tag: 'Fresh pick'
	},
	{
		name: 'Chicken & Greens', price: 15.5, category: 'salads',
		detail: 'Grilled chicken · garden greens · herbed dressing',
		image: '/assets/food/fresh-salad.jpg',
		imageAlt: 'Fresh salad bowl topped with colorful vegetables', tag: 'High protein'
	},
	{
		name: 'Golden Crispy Fries', price: 5.5, category: 'sides',
		detail: 'Hand-cut potatoes · sea salt · garlic aioli',
		image: '/assets/food/crispy-fries.jpg',
		imageAlt: 'Crispy golden french fries ready to share', tag: 'Add a side'
	},
	{
		name: 'Firecracker Wings', price: 10, category: 'sides',
		detail: 'Sticky chili glaze · toasted sesame · lime',
		image: '/assets/food/chicken-wings.jpg',
		imageAlt: 'Crispy chicken wings with a savory glaze', tag: 'A little heat'
	},
	{
		name: 'Chocolate Fudge Cake', price: 7, category: 'desserts',
		detail: 'Rich cocoa · whipped chocolate · baked in-house',
		image: '/assets/food/chocolate-cake.jpg',
		imageAlt: 'Rich chocolate cake with glossy fudge frosting', tag: 'Sweet finish'
	},
	{
		name: 'Berry Cheesecake', price: 7.5, category: 'desserts',
		detail: 'Vanilla cheesecake · berry compote · buttery crumb',
		image: '/assets/food/dessert.jpg',
		imageAlt: 'Sweet dessert with a fresh berry topping', tag: 'Made today'
	},
	{
		name: 'Citrus Fizz', price: 4, category: 'drinks',
		detail: 'Fresh lemon · sparkling water · mint',
		image: '/assets/food/citrus-soda.jpg',
		imageAlt: 'Bright, refreshing citrus drink served chilled', tag: 'Cold & fresh'
	},
	{
		name: 'Chef’s Table Plate', price: 19, category: 'specials',
		detail: 'Daily chef selection · market-fresh sides',
		image: '/assets/food/chef-special.jpg',
		imageAlt: 'Chef’s freshly prepared special served for dinner', tag: 'Today only'
	}
];

export const products = menu.map((product, index) => ({
	id: `food-${index + 1}`,
	...product
}));
